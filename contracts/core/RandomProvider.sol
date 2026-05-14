// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";
import {IRandomConsumer} from "../interfaces/core/IRandomConsumer.sol";
import {UnauthorizedCaller, InvalidMaxNumber, InvalidRequestId, SubscriptionNotSet, ExceedsMaxRanges, RequestNotPending, RequestTimedOut, InvalidRandomWords} from "../shared/Errors.sol";

/**
 * @title RandomProvider
 * @notice Optimized VRF provider with reduced gas costs
 * @dev Key optimizations vs V1:
 *      1. Removed allRequestIds array (saves ~20k gas per request)
 *      2. Removed consumerRequests mapping (saves ~20k gas per request)
 *      3. Uses mapping for pending status (O(1) vs O(n) removal)
 *      4. Doesn't store derivedValues (saves ~140k gas for 7 ranges)
 *      5. Reduced default callbackGasLimitBase
 *      6. Cleaner storage layout
 */
contract RandomProvider is VRFConsumerBaseV2Plus {
    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant FAILURE_TIMEOUT = keccak256("TIMEOUT");
    bytes32 public constant FAILURE_CONSUMER_REVERT = keccak256("CONSUMER_REVERT");
    bytes32 public constant FAILURE_CONSUMER_ERROR = keccak256("CONSUMER_ERROR");

    uint256 public constant DEFAULT_MAX_RANGES = 1;
    uint256 public constant ABSOLUTE_MAX_RANGES = 64;
    uint256 public constant REQUEST_TIMEOUT = 24 hours;
    uint256 public constant MIN_GAS_LIMIT = 100000;
    uint256 public constant ABSOLUTE_MAX_CALLBACK_GAS = 2_500_000;
    uint16 public constant MAX_REQUEST_CONFIRMATIONS = 200;

    // ═══════════════════════════════════════════════════════════════════════
    // ENUMS & STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    enum RequestStatus {
        NonExistent,
        Pending,
        Fulfilled,
        Failed
    }

    /// @dev Packed request data - optimized for gas
    struct RequestData {
        address consumer;           // 20 bytes
        RequestStatus status;       // 1 byte
        uint40 timestamp;           // 5 bytes (good until year 36812)
        uint8 rangeCount;           // 1 byte (max 64)
        // 32 bytes total - fits in one slot with tight packing
        uint256 rawWord;            // slot 2
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════

    // VRF configuration
    bytes32 public keyHash;
    uint256 public subId;
    uint16 public requestConfirmations;
    uint32 public callbackGasLimitBase;
    uint32 public extraGasPerWord;

    // Consumer management
    mapping(address => bool) public allowedConsumers;
    mapping(address => uint256) public maxRangesAllowed;

    // Request tracking - OPTIMIZED
    mapping(uint256 => RequestData) public requestData;
    mapping(uint256 => RandomDeriveLib.Range[]) private requestRanges;
    
    // Simple counters (no unbounded arrays!)
    uint256 public totalRequests;
    uint256 public pendingRequestCount;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event ConsumerStatusUpdated(address indexed consumer, bool status, uint256 maxRanges);
    event RandomWordsRequested(
        uint256 indexed requestId,
        address indexed consumer,
        uint256 rangeCount,
        uint256 gasLimit,
        RandomDeriveLib.Range[] ranges  // Kept for Graph compatibility
    );
    event RandomWordsFulfilled(
        uint256 indexed requestId,
        uint256 randomWord,
        uint256[] derivedValues
    );
    event RequestFailed(uint256 indexed requestId, string reason);
    event SubscriptionIdSet(uint256 indexed subId);
    event ConfigUpdated(
        uint16 requestConfirmations,
        uint32 callbackGasLimitBase,
        uint32 extraGasPerWord
    );
    event FailureNotificationFailed(
        uint256 indexed requestId, 
        address indexed consumer, 
        bytes32 failureTag, 
        bytes reason
    );

    // ═══════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    modifier onlyAllowedConsumer() {
        if (!allowedConsumers[msg.sender]) revert UnauthorizedCaller();
        _;
    }

    modifier validRequest(uint256 requestId) {
        if (requestData[requestId].consumer == address(0)) revert InvalidRequestId();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _vrfCoordinator) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        // Optimized defaults
        keyHash = 0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be; // 50 gwei
        requestConfirmations = 3;
        callbackGasLimitBase = 800000;  // Reduced from 2.5M - actual needs ~500-700k
        extraGasPerWord = 5000;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // OWNER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function setKeyHash(bytes32 _keyHash) external onlyOwner {
        require(_keyHash != 0, "Invalid key hash");
        bytes32 oldKeyHash = keyHash;
        keyHash = _keyHash;
        emit KeyHashUpdated(oldKeyHash, _keyHash);
    }

    event KeyHashUpdated(bytes32 oldKeyHash, bytes32 newKeyHash);

    function setSubscriptionId(uint256 _subId) external onlyOwner {
        require(_subId != 0, "Invalid subscription ID");
        subId = _subId;
        emit SubscriptionIdSet(_subId);
    }

    function setConsumerStatus(
        address consumer,
        bool status,
        uint256 maxRanges
    ) external onlyOwner {
        require(consumer != address(0), "Invalid consumer address");
        
        uint256 rangesAllowed = maxRanges == 0 ? DEFAULT_MAX_RANGES : maxRanges;
        if (maxRanges > 0) {
            require(maxRanges <= ABSOLUTE_MAX_RANGES, "Invalid max ranges");
        }
        
        allowedConsumers[consumer] = status;
        maxRangesAllowed[consumer] = rangesAllowed;
        emit ConsumerStatusUpdated(consumer, status, rangesAllowed);
    }

    function setConfig(
        uint16 _requestConfirmations,
        uint32 _callbackGasLimitBase,
        uint32 _extraGasPerWord
    ) external onlyOwner {
        require(
            _requestConfirmations >= 3 && _requestConfirmations <= MAX_REQUEST_CONFIRMATIONS, 
            "Invalid confirmations"
        );
        require(_callbackGasLimitBase >= MIN_GAS_LIMIT, "Gas limit too low");
        
        requestConfirmations = _requestConfirmations;
        callbackGasLimitBase = _callbackGasLimitBase;
        extraGasPerWord = _extraGasPerWord;
        
        emit ConfigUpdated(_requestConfirmations, _callbackGasLimitBase, _extraGasPerWord);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // REQUEST FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Request a single random number
     * @param maxNumber Upper bound (exclusive) for the random number
     */
    function requestRandomNumber(uint256 maxNumber) external onlyAllowedConsumer returns (uint256) {
        if (maxNumber == 0) revert InvalidMaxNumber();

        // Note: the cast to uint128 silently truncates values above type(uint128).max.
        // Consumers like CrashGame intentionally pass type(uint256).max to mean "any
        // value, no range cap" — they read the raw VRF word via getRawWord rather than
        // a derived range — so a stricter `> type(uint128).max` revert here would break
        // them. Keep the validation permissive; callers that DO want a range bound are
        // expected to pass a value within uint128.
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: uint128(maxNumber)});
        return _requestRandomWords(ranges);
    }
    
    /**
     * @notice Request multiple random numbers with specific ranges
     * @param ranges Array of range descriptors
     */
    function requestRandomNumbers(
        RandomDeriveLib.Range[] calldata ranges
    ) external onlyAllowedConsumer returns (uint256) {
        RandomDeriveLib.Range[] memory rangesCopy = new RandomDeriveLib.Range[](ranges.length);
        for (uint256 i = 0; i < ranges.length; i++) {
            rangesCopy[i] = ranges[i];
        }
        return _requestRandomWords(rangesCopy);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL REQUEST LOGIC
    // ═══════════════════════════════════════════════════════════════════════

    function _requestRandomWords(
        RandomDeriveLib.Range[] memory ranges
    ) internal returns (uint256) {
        if (ranges.length == 0) revert InvalidMaxNumber();
        if (subId == 0) revert SubscriptionNotSet();
        
        uint256 authorizedRanges = maxRangesAllowed[msg.sender];
        if (ranges.length > authorizedRanges) revert ExceedsMaxRanges();

        // Validate ranges
        for (uint256 i = 0; i < ranges.length; i++) {
            if (ranges[i].max <= ranges[i].min) revert InvalidMaxNumber();
        }

        // callbackGasLimitBase = gas reserved for the consumer's base callback overhead.
        // extraGasPerWord     = additional gas per derived range.
        // Hard ceiling enforced at ABSOLUTE_MAX_CALLBACK_GAS so a misconfigured base
        // never silently exceeds the VRF coordinator's per-callback ceiling.
        uint256 totalGas = uint256(callbackGasLimitBase) + (ranges.length * uint256(extraGasPerWord));
        require(totalGas <= ABSOLUTE_MAX_CALLBACK_GAS, "Callback gas exceeds max");
        uint32 safeGasLimit = uint32(totalGas);

        // Request from VRF
        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: safeGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        // Store request data - OPTIMIZED: single slot write
        requestData[requestId] = RequestData({
            consumer: msg.sender,
            status: RequestStatus.Pending,
            timestamp: uint40(block.timestamp),
            rangeCount: uint8(ranges.length),
            rawWord: 0
        });

        // Store ranges temporarily
        RandomDeriveLib.Range[] storage storedRanges = requestRanges[requestId];
        for (uint256 i = 0; i < ranges.length; i++) {
            storedRanges.push(ranges[i]);
        }

        // Update counters - NO ARRAY PUSH!
        totalRequests++;
        pendingRequestCount++;

        emit RandomWordsRequested(requestId, msg.sender, ranges.length, safeGasLimit, ranges);
        return requestId;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FULFILLMENT
    // ═══════════════════════════════════════════════════════════════════════

    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override validRequest(requestId) {
        RequestData storage data = requestData[requestId];
        
        if (randomWords.length != 1) revert InvalidRandomWords();

        // Check timeout
        if (block.timestamp > data.timestamp + REQUEST_TIMEOUT) {
            data.status = RequestStatus.Failed;
            _notifyFailure(
                IRandomConsumer(data.consumer), 
                requestId, 
                FAILURE_TIMEOUT, 
                bytes("")
            );
            _cleanup(requestId);
            emit RequestFailed(requestId, "Timeout");
            return;
        }

        uint256 vrfWord = randomWords[0];
        data.rawWord = vrfWord;

        // Load and derive values
        RandomDeriveLib.Range[] storage storedRanges = requestRanges[requestId];
        RandomDeriveLib.Range[] memory rangesCopy = new RandomDeriveLib.Range[](storedRanges.length);
        for (uint256 i = 0; i < storedRanges.length; i++) {
            rangesCopy[i] = storedRanges[i];
        }

        (uint256[] memory derivedValues, ) = RandomDeriveLib.deriveBounded(vrfWord, rangesCopy);
        
        // NOTE: We do NOT store derivedValues! This saves ~140k gas for 7 ranges
        // Consumers can re-derive if needed using rawWord

        // Call consumer
        IRandomConsumer consumer = IRandomConsumer(data.consumer);
        bool success = true;
        string memory failureReason = "";

        try consumer.fulfillRandomness(requestId, vrfWord, derivedValues) {
            data.status = RequestStatus.Fulfilled;
        } catch Error(string memory reason) {
            success = false;
            failureReason = reason;
            data.status = RequestStatus.Failed;
            _notifyFailure(consumer, requestId, FAILURE_CONSUMER_REVERT, bytes(reason));
        } catch (bytes memory lowLevelData) {
            success = false;
            failureReason = "Low-level error";
            data.status = RequestStatus.Failed;
            _notifyFailure(consumer, requestId, FAILURE_CONSUMER_ERROR, lowLevelData);
        }

        // Cleanup
        _cleanup(requestId);

        if (success) {
            emit RandomWordsFulfilled(requestId, vrfWord, derivedValues);
        } else {
            emit RequestFailed(requestId, failureReason);
        }
    }

    function _notifyFailure(
        IRandomConsumer consumer, 
        uint256 requestId, 
        bytes32 tag, 
        bytes memory details
    ) internal {
        try consumer.handleRandomFailure(requestId, tag, details) {
        } catch (bytes memory reason) {
            emit FailureNotificationFailed(
                requestId, 
                address(consumer), 
                tag, 
                reason.length == 0 ? bytes("") : reason
            );
        }
    }

    function _cleanup(uint256 requestId) internal {
        delete requestRanges[requestId];
        
        // O(1) decrement instead of O(n) array removal
        if (pendingRequestCount > 0) {
            pendingRequestCount--;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function getRequestStatus(uint256 requestId) external view returns (RequestStatus) {
        return requestData[requestId].status;
    }

    function getRequestData(uint256 requestId) external view returns (
        address consumer,
        RequestStatus status,
        uint256 timestamp,
        uint256 rangeCount,
        uint256 rawWord
    ) {
        RequestData memory data = requestData[requestId];
        return (
            data.consumer,
            data.status,
            uint256(data.timestamp),
            uint256(data.rangeCount),
            data.rawWord
        );
    }

    function getRawWord(uint256 requestId) external view returns (uint256) {
        return requestData[requestId].rawWord;
    }

    function getPendingRequestCount() external view returns (uint256) {
        return pendingRequestCount;
    }

    // Compatibility with V1 interface
    function failureReasonTimeout() public pure returns (bytes32) {
        return FAILURE_TIMEOUT;
    }

    function failureReasonConsumerRevert() public pure returns (bytes32) {
        return FAILURE_CONSUMER_REVERT;
    }

    function failureReasonConsumerError() public pure returns (bytes32) {
        return FAILURE_CONSUMER_ERROR;
    }

    /**
     * @notice Re-derive values from stored rawWord (for debugging/verification)
     * @dev Consumers should cache derivedValues if they need them later
     */
    function rederiveValues(
        uint256 requestId,
        RandomDeriveLib.Range[] calldata ranges
    ) external view returns (uint256[] memory) {
        RequestData memory data = requestData[requestId];
        require(data.status == RequestStatus.Fulfilled, "Request not fulfilled");

        (uint256[] memory values, ) = RandomDeriveLib.deriveBounded(data.rawWord, ranges);
        return values;
    }

    /**
     * @notice Force-fail a request that the VRF coordinator never answered.
     * @dev Releases the consumer's locked exposure by invoking handleRandomFailure.
     *      Only callable after REQUEST_TIMEOUT has elapsed since the request, so it
     *      cannot be used to short-circuit a still-in-flight VRF response.
     */
    function forceFailRequest(uint256 requestId) external onlyOwner {
        RequestData storage data = requestData[requestId];
        if (data.consumer == address(0)) revert InvalidRequestId();
        if (data.status != RequestStatus.Pending) revert RequestNotPending();
        require(block.timestamp > data.timestamp + REQUEST_TIMEOUT, "Not yet eligible");

        data.status = RequestStatus.Failed;
        _notifyFailure(IRandomConsumer(data.consumer), requestId, FAILURE_TIMEOUT, bytes(""));
        _cleanup(requestId);
        emit RequestFailed(requestId, "Force-failed");
    }
}

