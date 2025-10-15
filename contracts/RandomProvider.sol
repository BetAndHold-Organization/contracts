// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {RandomDeriveLib} from "./libraries/RandomDeriveLib.sol";
import {IRandomConsumer} from "./interfaces/IRandomConsumer.sol";
import {UnauthorizedCaller, InvalidMaxNumber, InvalidRequestId, SubscriptionNotSet, ExceedsMaxRanges, RequestNotPending, RequestTimedOut, InvalidRandomWords} from "./Shared/Errors.sol";

/**
 * @title RandomProvider
 * @notice Provides verifiable random numbers using Chainlink VRF v2.5
 * @dev Manages random number requests and fulfillment for authorized consumers
 */
contract RandomProvider is VRFConsumerBaseV2Plus {
    bytes32 public constant FAILURE_TIMEOUT = keccak256("TIMEOUT");
    bytes32 public constant FAILURE_CONSUMER_REVERT = keccak256("CONSUMER_REVERT");
    bytes32 public constant FAILURE_CONSUMER_ERROR = keccak256("CONSUMER_ERROR");

    // State variables
    bytes32 public keyHash;
    uint256 public subId;
    
    // Constants
    uint256 public constant DEFAULT_MAX_RANGES = 1;
    uint256 public constant ABSOLUTE_MAX_RANGES = 64; // Maximum allowed to prevent gas issues
    uint256 public constant REQUEST_TIMEOUT = 24 hours;
    uint256 public constant MIN_GAS_LIMIT = 100000;
    uint16 public constant MAX_REQUEST_CONFIRMATIONS = 200; // VRF max confirmations
    
    // Configurable parameters
    uint16 public requestConfirmations;
    uint32 public callbackGasLimitBase;
    uint32 public extraGasPerWord;
    
    // Request status enum
    enum RequestStatus {
        NonExistent,
        Pending,
        Fulfilled,
        Failed
    }
    
    // Request data structure
    struct RequestData {
        address consumer;
        RequestStatus status;
        uint256 timestamp;
        uint256 gasLimit;
        uint256 rawWord;
        uint256[] derivedValues;
        uint256 rangeCount;
    }
    
    // Mappings
    mapping(address => bool) public allowedConsumers;
    mapping(address => uint256) public maxRangesAllowed;
    mapping(uint256 => RequestData) public requestIdToData;
    mapping(uint256 => RandomDeriveLib.Range[]) private requestIdToRanges;
    
    // New tracking state variables
    uint256[] public allRequestIds;
    mapping(address => uint256[]) public consumerRequests;
    uint256[] public pendingRequestIds;
    uint256 public totalRequests;
    
    // Events
    event ConsumerStatusUpdated(address indexed consumer, bool status, uint256 maxRanges);
    event RandomWordsRequested(
        uint256 indexed requestId,
        address indexed consumer,
        uint256 rangeCount,
        uint256 gasLimit,
        RandomDeriveLib.Range[] ranges
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
    event RequestAdded(uint256 indexed requestId, address indexed consumer, uint256 timestamp);
    event RequestCompleted(uint256 indexed requestId, RequestStatus status);
    event FailureNotificationFailed(uint256 indexed requestId, address indexed consumer, bytes32 failureTag, bytes reason);

    // Modifiers
    modifier onlyAllowedConsumer() {
        if (!allowedConsumers[msg.sender]) revert UnauthorizedCaller();
        _;
    }

    modifier validRequest(uint256 requestId) {
        if (requestIdToData[requestId].consumer == address(0)) revert InvalidRequestId();
        _;
    }

    /**
     * @dev Constructor initializes the contract with default values
     * @param _vrfCoordinator The address of the VRF Coordinator
     */
    constructor(address _vrfCoordinator) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        // Initialize with default values
        keyHash = 0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be; // 50 gwei key hash
        requestConfirmations = 3; // VRF minimum confirmations
        callbackGasLimitBase = 2500000; // VRF max gas limit
        extraGasPerWord = 5000; // Reduced to allow for multiple words within the limit
    }

    /**
     * @notice Sets the key hash for VRF requests
     * @param _keyHash The new key hash to use
     */
    function setKeyHash(bytes32 _keyHash) external onlyOwner {
        require(_keyHash != 0, "Invalid key hash");
        keyHash = _keyHash;
    }

    /**
     * @notice Sets the subscription ID for VRF requests
     * @param _subId The new subscription ID to use
     */
    function setSubscriptionId(uint256 _subId) external onlyOwner {
        require(_subId != 0, "Invalid subscription ID");
        subId = _subId;
        emit SubscriptionIdSet(_subId);
    }

    /**
     * @notice Updates the status and max ranges allowed for a consumer
     * @param consumer The consumer address to update
     * @param status Whether the consumer is allowed to request random numbers
     * @param maxRanges Maximum number of ranges the consumer can request at once
     */
    function setConsumerStatus(
        address consumer,
        bool status,
        uint256 maxRanges
    ) external onlyOwner {
        require(consumer != address(0), "Invalid consumer address");
        
        // If maxRanges is 0, use the default value
        uint256 rangesAllowed = maxRanges == 0 ? DEFAULT_MAX_RANGES : maxRanges;
        
        // Validate maxRanges if a custom value is provided
        if (maxRanges > 0) {
            require(maxRanges <= ABSOLUTE_MAX_RANGES, "Invalid max ranges");
        }
        
        allowedConsumers[consumer] = status;
        maxRangesAllowed[consumer] = rangesAllowed;
        emit ConsumerStatusUpdated(consumer, status, rangesAllowed);
    }

    /**
     * @notice Updates the configuration parameters
     * @param _requestConfirmations Number of confirmations to wait
     * @param _callbackGasLimitBase Base gas limit for callbacks
     * @param _extraGasPerWord Additional gas per random word
     */
    function setConfig(
        uint16 _requestConfirmations,
        uint32 _callbackGasLimitBase,
        uint32 _extraGasPerWord
    ) external onlyOwner {
        // Validate confirmations against VRF limits
        require(_requestConfirmations >= 3 && _requestConfirmations <= MAX_REQUEST_CONFIRMATIONS, 
            "Invalid confirmations");
        require(_callbackGasLimitBase >= MIN_GAS_LIMIT, "Gas limit too low");
        
        requestConfirmations = _requestConfirmations;
        callbackGasLimitBase = _callbackGasLimitBase;
        extraGasPerWord = _extraGasPerWord;
        
        emit ConfigUpdated(_requestConfirmations, _callbackGasLimitBase, _extraGasPerWord);
    }

    /**
     * @notice Requests a single random number
     * @param maxNumber The upper bound (exclusive) for the random number
     * @return requestId The ID of the random number request
     */
    function requestRandomNumber(
        uint256 maxNumber
    ) external onlyAllowedConsumer returns (uint256) {
        if (maxNumber == 0) revert InvalidMaxNumber();

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: uint128(maxNumber)});
        return _requestRandomWords(ranges);
    }
    
    /**
     * @notice Requests multiple random numbers with specific ranges
     * @param ranges Array of range descriptors defining the bounds for each derived number
     * @return requestId The ID of the random number request
     */
    function requestRandomNumbers(
        RandomDeriveLib.Range[] calldata ranges
    ) external onlyAllowedConsumer returns (uint256) {
        // Copy to memory to satisfy internal function signature
        RandomDeriveLib.Range[] memory rangesCopy = new RandomDeriveLib.Range[](ranges.length);
        for (uint256 i = 0; i < ranges.length; i++) {
            rangesCopy[i] = ranges[i];
        }
        return _requestRandomWords(rangesCopy);
    }

    /**
     * @notice Internal helper to request randomness from VRF
     * @param ranges Array of range descriptors defining the bounds for each derived number
     * @return requestId The ID of the request
     */
    function _requestRandomWords(
        RandomDeriveLib.Range[] memory ranges
    ) internal returns (uint256) {
        if (ranges.length == 0) revert InvalidMaxNumber();
        if (subId == 0) revert SubscriptionNotSet();
        
        // Ensure requested ranges is within authorized limit
        uint256 authorizedRanges = maxRangesAllowed[msg.sender];
        if (ranges.length > authorizedRanges) revert ExceedsMaxRanges();

        for (uint256 i = 0; i < ranges.length; i++) {
            RandomDeriveLib.Range memory range = ranges[i];
            if (range.max <= range.min) revert InvalidMaxNumber();
        }
        // Calculate gas limit ensuring we don't exceed the max
        uint256 baseGas = callbackGasLimitBase - (callbackGasLimitBase / 10); // Leave 10% buffer
        uint256 totalGas = baseGas + (ranges.length * extraGasPerWord);
        
        // Cap at callback gas limit if needed
        uint32 safeGasLimit = totalGas > callbackGasLimitBase ? callbackGasLimitBase : uint32(totalGas);
        
        // Request random words from Chainlink VRF
        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: safeGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
            })
        );

        // Store request data
        requestIdToData[requestId] = RequestData({
            consumer: msg.sender,
            status: RequestStatus.Pending,
            timestamp: block.timestamp,
            gasLimit: safeGasLimit,
            rawWord: 0,
            derivedValues: new uint256[](0),
            rangeCount: ranges.length
        });

        // Store ranges for the duration of the pending request
        RandomDeriveLib.Range[] storage storedRanges = requestIdToRanges[requestId];
        for (uint256 i = 0; i < ranges.length; i++) {
            storedRanges.push(ranges[i]);
        }

        // Add to tracking
        _addRequest(requestId, msg.sender);

        emit RandomWordsRequested(requestId, msg.sender, ranges.length, safeGasLimit, ranges);
        return requestId;
    }

    /**
     * @notice Fulfills a random words request
     * @param requestId The ID of the request to fulfill
     * @param randomWords The random words from VRF
     */
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override validRequest(requestId) {
        RequestData storage data = requestIdToData[requestId];
        IRandomConsumer consumer = IRandomConsumer(data.consumer);

        if (randomWords.length != 1) revert InvalidRandomWords();

        if (block.timestamp > data.timestamp + REQUEST_TIMEOUT) {
            data.status = RandomProvider.RequestStatus.Failed;
            bytes memory timeoutDetails = bytes("");
            _notifyFailure(consumer, requestId, FAILURE_TIMEOUT, timeoutDetails);
            _removeFromPending(requestId);
            emit RequestFailed(requestId, "Timeout");
            emit RequestCompleted(requestId, data.status);
            return;
        }

        uint256 vrfWord = randomWords[0];
        data.rawWord = vrfWord;

        RandomDeriveLib.Range[] storage storedRanges = requestIdToRanges[requestId];
        RandomDeriveLib.Range[] memory rangesCopy = new RandomDeriveLib.Range[](storedRanges.length);
        for (uint256 i = 0; i < storedRanges.length; i++) {
            rangesCopy[i] = storedRanges[i];
        }

        (uint256[] memory derivedValues, ) = RandomDeriveLib.deriveBounded(vrfWord, rangesCopy);
        data.derivedValues = derivedValues;

        bool success = true;
        string memory failureReason = "";

        try consumer.fulfillRandomness(requestId, vrfWord, derivedValues) {
            data.status = RandomProvider.RequestStatus.Fulfilled;
        } catch Error(string memory reason) {
            success = false;
            failureReason = reason;
            data.status = RandomProvider.RequestStatus.Failed;
            _notifyFailure(consumer, requestId, FAILURE_CONSUMER_REVERT, bytes(reason));
        } catch (bytes memory lowLevelData) {
            success = false;
            failureReason = "Low-level error";
            data.status = RandomProvider.RequestStatus.Failed;
            _notifyFailure(consumer, requestId, FAILURE_CONSUMER_ERROR, lowLevelData);
        }

        delete requestIdToRanges[requestId];
        _removeFromPending(requestId);

        if (success) {
            emit RandomWordsFulfilled(requestId, vrfWord, derivedValues);
        } else {
            emit RequestFailed(requestId, failureReason);
        }

        emit RequestCompleted(requestId, data.status);
    }

    function _notifyFailure(IRandomConsumer consumer, uint256 requestId, bytes32 tag, bytes memory details) internal {
        try consumer.handleRandomFailure(requestId, tag, details) {} catch (bytes memory reason) {
            bytes memory emitted = reason.length == 0 ? bytes("") : reason;
            emit FailureNotificationFailed(requestId, address(consumer), tag, emitted);
        }
    }

    /**
     * @notice Gets the status of a request
     * @param requestId The ID of the request
     * @return status The current status of the request
     */
    function getRequestStatus(
        uint256 requestId
    ) external view returns (RequestStatus) {
        return requestIdToData[requestId].status;
    }

    function getRequestData(uint256 requestId) external view returns (RequestData memory) {
        return requestIdToData[requestId];
    }

    function getDerivedValues(uint256 requestId) external view returns (uint256[] memory) {
        return requestIdToData[requestId].derivedValues;
    }

    function getRawWord(uint256 requestId) external view returns (uint256) {
        return requestIdToData[requestId].rawWord;
    }

    function failureReasonTimeout() public pure returns (bytes32) {
        return FAILURE_TIMEOUT;
    }

    function failureReasonConsumerRevert() public pure returns (bytes32) {
        return FAILURE_CONSUMER_REVERT;
    }

    function failureReasonConsumerError() public pure returns (bytes32) {
        return FAILURE_CONSUMER_ERROR;
    }

    // New functions for request management
    function getAllRequestIds() external view returns (uint256[] memory) {
        return allRequestIds;
    }
    
    function getConsumerRequests(address consumer) external view returns (uint256[] memory) {
        return consumerRequests[consumer];
    }
    
    function getPendingRequestIds() external view returns (uint256[] memory) {
        return pendingRequestIds;
    }
    
    function getPendingRequestCount() external view returns (uint256) {
        return pendingRequestIds.length;
    }
    
    function getConsumerRequestCount(address consumer) external view returns (uint256) {
        return consumerRequests[consumer].length;
    }

    // Internal helper functions
    function _addRequest(uint256 requestId, address consumer) internal {
        allRequestIds.push(requestId);
        consumerRequests[consumer].push(requestId);
        pendingRequestIds.push(requestId);
        totalRequests++;
        
        emit RequestAdded(requestId, consumer, block.timestamp);
    }
    
    function _removeFromPending(uint256 requestId) internal {
        uint256 length = pendingRequestIds.length;
        for (uint256 i = 0; i < length; i++) {
            if (pendingRequestIds[i] == requestId) {
                // Move the last element to this position and pop
                pendingRequestIds[i] = pendingRequestIds[length - 1];
                pendingRequestIds.pop();
                break;
            }
        }
    }
}
