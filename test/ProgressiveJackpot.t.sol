// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ProgressiveJackpotTestBase} from "./utils/ProgressiveJackpotTestBase.sol";
import {ProgressiveJackpot} from "contracts/ProgressiveJackpot.sol";

contract ProgressiveJackpotTest is ProgressiveJackpotTestBase {
    function setUp() public override {
        super.setUp();
        registerSimpleLadder();
        registerGameWithOutcomes(gameA);
        configureDefaultDirectBet(true);
    }

    function test_registerGameStoresOutcomes() public {
        ProgressiveJackpot.OutcomeConfig[] memory stored = jackpot.getGameOutcomes(gameA);
        assertEq(stored.length, 4);
        assertEq(stored[0].cumulativeProbability, 3_000);
        assertTrue(stored[0].awardsTier);
        assertEq(stored[1].consolationMultiplier, 12_000);
        assertEq(stored[2].consolationMultiplier, 15_000);
        assertFalse(stored[3].awardsTier);
    }

    function test_setTierLadderOverridesPrevious() public {
        ProgressiveJackpot.TierConfig[] memory tiers = jackpot.getTierLadder();
        assertEq(tiers.length, 9);
        assertFalse(tiers[0].isPercent);
        assertFalse(tiers[1].isPercent);

        ProgressiveJackpot.TierConfig[] memory newTiers = new ProgressiveJackpot.TierConfig[](2);
        newTiers[0] = ProgressiveJackpot.TierConfig({
            prizeMetric: 2_000 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 5 ether,
            useDynamicCost: false
        });
        newTiers[1] = ProgressiveJackpot.TierConfig({
            prizeMetric: 50_000,
            isTerminal: true,
            isPercent: true,
            fixedBetCost: 0,
            useDynamicCost: true
        });

        vm.prank(owner);
        jackpot.setTierLadder(newTiers);

        ProgressiveJackpot.TierConfig[] memory stored = jackpot.getTierLadder();
        assertEq(stored.length, 2);
        assertEq(stored[0].prizeMetric, 2_000 ether);
        assertFalse(stored[0].isPercent);
        assertTrue(stored[1].isTerminal);
    }

    function test_addFundsRequiresRegisteredGame() public {
        vm.expectRevert(ProgressiveJackpot.UnauthorizedCaller.selector);
        jackpot.addFunds(1 ether);
    }

    function test_addFundsPullsTokens() public {
        vm.startPrank(gameA);
        eva.approve(address(jackpot), 50 ether);
        jackpot.addFunds(50 ether);
        vm.stopPrank();

        assertEq(eva.balanceOf(address(jackpot)), 100_050 ether);
        assertEq(eva.balanceOf(gameA), 999_950 ether);
    }

    function test_processJackpotEntryAwardsTierWhenRollMatches() public {
        uint256 balanceBefore = eva.balanceOf(player);
        vm.prank(gameA);
        uint256 payout = jackpot.processJackpotEntry(player, 1 ether, 2_500);

        assertEq(payout, 100 ether);
        assertEq(eva.balanceOf(player), balanceBefore + payout);

        (uint8 tierIndex,,) = jackpot.getCurrentTierInfo();
        assertEq(tierIndex, 1);
    }

    function test_processJackpotEntryPaysConsolation() public {
        uint256 balanceBefore = eva.balanceOf(player);

        vm.prank(gameA);
        uint256 payout = jackpot.processJackpotEntry(player, 2 ether, 5_500);

        assertEq(payout, 2_400_000_000_000_000_000); // 2 ether * 12_000 / 10_000 = 2.4 ether
        assertEq(eva.balanceOf(player), balanceBefore + payout);

        ProgressiveJackpot.EntryRecord memory record = jackpot.getEntry(0);
        assertEq(record.outcomeIndex, 1);
        assertEq(record.payout, payout);
    }

    function test_processJackpotEntryNoPayoutOnLose() public {
        uint256 balanceBefore = eva.balanceOf(player);

        vm.prank(gameA);
        uint256 payout = jackpot.processJackpotEntry(player, 2 ether, 9_999);

        assertEq(payout, 0);
        assertEq(eva.balanceOf(player), balanceBefore);
    }

    function test_awardTierFailsWithoutFunds() public {
        uint256 balance = eva.balanceOf(address(jackpot));
        vm.startPrank(address(jackpot));
        eva.transfer(owner, balance);
        vm.stopPrank();

        vm.prank(gameA);
        vm.expectRevert(ProgressiveJackpot.InsufficientFunds.selector);
        jackpot.processJackpotEntry(player, 1 ether, 2_000);
    }

    function test_setGameStatusDisablesProcessing() public {
        vm.prank(owner);
        jackpot.setGameStatus(gameA, false);

        vm.prank(gameA);
        vm.expectRevert(abi.encodeWithSelector(ProgressiveJackpot.GameDisabled.selector, gameA));
        jackpot.processJackpotEntry(player, 1 ether, 2_000);
    }

    function test_processJackpotEntryAdvancesMultipleTiers() public {
        vm.startPrank(gameA);
        eva.approve(address(jackpot), 1_000 ether);
        jackpot.addFunds(1_000 ether);
        vm.stopPrank();

        vm.prank(gameA);
        jackpot.processJackpotEntry(player, 1 ether, 2_500);
        vm.prank(gameA);
        jackpot.processJackpotEntry(player, 1 ether, 2_500);

        (uint8 tierIndex,,) = jackpot.getCurrentTierInfo();
        assertEq(tierIndex, 2);
    }

    function test_terminalTierResetsProgression() public {
        vm.startPrank(gameA);
        eva.approve(address(jackpot), 5_000 ether);
        jackpot.addFunds(5_000 ether);
        vm.stopPrank();

        vm.prank(gameA);
        jackpot.processJackpotEntry(player, 1 ether, 2_500);
        (uint8 afterFirst,,) = jackpot.getCurrentTierInfo();
        assertEq(afterFirst, 1);

        for (uint256 i = 0; i < 7; i++) {
            vm.prank(gameA);
            jackpot.processJackpotEntry(player, 1 ether, 2_500);
        }
        (uint8 afterTerminal,,) = jackpot.getCurrentTierInfo();
        assertEq(afterTerminal, 0);
    }

    function test_totalConsolationPaidTracksPayouts() public {
        vm.prank(gameA);
        uint256 payout = jackpot.processJackpotEntry(player, 2 ether, 5_500);

        ProgressiveJackpot.JackpotState memory state = jackpot.getJackpotState();
        assertEq(state.totalConsolationPaid, payout);
    }

    function test_processRequiresRegisteredGame() public {
        vm.expectRevert(abi.encodeWithSelector(ProgressiveJackpot.InvalidGame.selector, address(this)));
        jackpot.processJackpotEntry(player, 1 ether, 1_000);
    }

    function test_getCurrentTierInfoReturnsPrize() public {
        (,, uint256 prize) = jackpot.getCurrentTierInfo();
        assertEq(prize, 100 ether);
    }

    function testFuzz_percentTierPrizeWithinBalance(uint256 extraFunds, uint16 roll) public {
        extraFunds = bound(extraFunds, 1 ether, 1_000_000 ether);
        roll = uint16(bound(uint256(roll), 0, 3_000));

        vm.startPrank(gameA);
        eva.approve(address(jackpot), extraFunds);
        jackpot.addFunds(extraFunds);
        vm.stopPrank();

        uint256 balanceBefore = eva.balanceOf(address(jackpot));

        vm.prank(gameA);
        jackpot.processJackpotEntry(player, 1 ether, roll);

        uint256 balanceAfter = eva.balanceOf(address(jackpot));
        assertLe(balanceAfter, balanceBefore);
    }

    function test_configureDirectBetStoresOutcomes() public {
        ProgressiveJackpot.OutcomeConfig[] memory outcomes = jackpot.getDirectBetOutcomes();
        assertEq(outcomes.length, 4);
        assertTrue(outcomes[0].awardsTier);
        assertEq(outcomes[1].consolationMultiplier, 12_000);
        assertEq(outcomes[2].consolationMultiplier, 15_000);
        assertFalse(outcomes[3].awardsTier);

        bool enabled = jackpot.directBetConfig();
        assertTrue(enabled);
    }

    function _directBetConfig() internal view returns (bool enabled) {
        return jackpot.directBetConfig();
    }
}


