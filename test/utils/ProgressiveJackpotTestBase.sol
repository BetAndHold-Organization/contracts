// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {ProgressiveJackpot} from "contracts/ProgressiveJackpot.sol";
import {EverValueCoin} from "contracts/Shared/EverValueCoin.sol";
import {MockRandomProvider} from "../mocks/MockRandomProvider.sol";

contract ProgressiveJackpotTestBase is Test {
    EverValueCoin internal eva;
    ProgressiveJackpot internal jackpot;
    MockRandomProvider internal mockProvider;

    address internal owner = address(0xA11CE);
    address internal gameA = address(0xBEEF);
    address internal gameB = address(0xCAFE);
    address internal player = address(0xFACE);

    function setUp() public virtual {
        eva = new EverValueCoin();
        mockProvider = new MockRandomProvider();

        vm.startPrank(owner);
        jackpot = new ProgressiveJackpot(address(eva), address(mockProvider));
        vm.stopPrank();

        deal(address(eva), owner, 1_000_000 ether);
        deal(address(eva), gameA, 1_000_000 ether);
        deal(address(eva), gameB, 1_000_000 ether);
        deal(address(eva), player, 1_000 ether);

        vm.prank(owner);
        eva.transfer(address(jackpot), 100_000 ether);
    }

    function registerSimpleLadder() internal {
        ProgressiveJackpot.TierConfig[] memory tiers = new ProgressiveJackpot.TierConfig[](9);
        tiers[0] = ProgressiveJackpot.TierConfig({
            prizeMetric: 100 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 5 ether,
            useDynamicCost: false
        });
        tiers[1] = ProgressiveJackpot.TierConfig({
            prizeMetric: 150 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 7 ether,
            useDynamicCost: false
        });
        tiers[2] = ProgressiveJackpot.TierConfig({
            prizeMetric: 200 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 9 ether,
            useDynamicCost: false
        });
        tiers[3] = ProgressiveJackpot.TierConfig({
            prizeMetric: 250 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 12 ether,
            useDynamicCost: false
        });
        tiers[4] = ProgressiveJackpot.TierConfig({
            prizeMetric: 300 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 15 ether,
            useDynamicCost: false
        });
        tiers[5] = ProgressiveJackpot.TierConfig({
            prizeMetric: 350 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 18 ether,
            useDynamicCost: false
        });
        tiers[6] = ProgressiveJackpot.TierConfig({
            prizeMetric: 400 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 20 ether,
            useDynamicCost: false
        });
        tiers[7] = ProgressiveJackpot.TierConfig({
            prizeMetric: 500 ether,
            isTerminal: false,
            isPercent: false,
            fixedBetCost: 25 ether,
            useDynamicCost: false
        });
        tiers[8] = ProgressiveJackpot.TierConfig({
            prizeMetric: 600 ether,
            isTerminal: true,
            isPercent: false,
            fixedBetCost: 30 ether,
            useDynamicCost: false
        });

        vm.prank(owner);
        jackpot.setTierLadder(tiers);
    }

    function registerGameWithOutcomes(address game) internal {
        ProgressiveJackpot.OutcomeConfig[] memory outcomes = new ProgressiveJackpot.OutcomeConfig[](4);
        outcomes[0] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 3_000,
            tierAdvance: 1,
            tierResetTo: 0,
            consolationMultiplier: 0,
            awardsTier: true
        });
        outcomes[1] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 6_000,
            tierAdvance: 0,
            tierResetTo: 0,
            consolationMultiplier: 12_000,
            awardsTier: false
        });
        outcomes[2] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 9_000,
            tierAdvance: 0,
            tierResetTo: 0,
            consolationMultiplier: 15_000,
            awardsTier: false
        });
        outcomes[3] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 10_000,
            tierAdvance: 0,
            tierResetTo: 0,
            consolationMultiplier: 0,
            awardsTier: false
        });

        vm.prank(owner);
        jackpot.registerGame(game, outcomes);
    }

    function configureDefaultDirectBet(bool enabled) internal {
        ProgressiveJackpot.OutcomeConfig[] memory outcomes = new ProgressiveJackpot.OutcomeConfig[](4);
        outcomes[0] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 2_500,
            tierAdvance: 1,
            tierResetTo: 0,
            consolationMultiplier: 0,
            awardsTier: true
        });
        outcomes[1] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 6_000,
            tierAdvance: 0,
            tierResetTo: 0,
            consolationMultiplier: 12_000,
            awardsTier: false
        });
        outcomes[2] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 9_000,
            tierAdvance: 0,
            tierResetTo: 0,
            consolationMultiplier: 15_000,
            awardsTier: false
        });
        outcomes[3] = ProgressiveJackpot.OutcomeConfig({
            cumulativeProbability: 10_000,
            tierAdvance: 0,
            tierResetTo: 0,
            consolationMultiplier: 0,
            awardsTier: false
        });

        vm.prank(owner);
        jackpot.configureDirectBet(enabled, outcomes);
    }
}


