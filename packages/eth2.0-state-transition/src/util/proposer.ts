/**
 * @module chain/stateTransition/util
 */

import {hash} from "@chainsafe/ssz";

import {
  BeaconState,
  ValidatorIndex,
} from "@chainsafe/eth2.0-types";
import {IBeaconConfig} from "@chainsafe/eth2.0-config";
import {intToBytes,intDiv} from "@chainsafe/eth2.0-utils";

import {getCurrentEpoch} from "./epoch";
import {getSeed} from "./seed";
import {getCommitteeCount, getStartShard, getCrosslinkCommittee} from "./committee";



/**
 * Return the beacon proposer index at ``state.slot``.
 */
export function getBeaconProposerIndex(config: IBeaconConfig, state: BeaconState): ValidatorIndex {
  const currentEpoch = getCurrentEpoch(config, state);
  const committeesPerSlot = intDiv(getCommitteeCount(config, state, currentEpoch), config.params.SLOTS_PER_EPOCH);
  const offset = committeesPerSlot * (state.slot % config.params.SLOTS_PER_EPOCH);
  const shard = (getStartShard(config, state, currentEpoch) + offset) % config.params.SHARD_COUNT;
  const firstCommittee = getCrosslinkCommittee(config, state, currentEpoch, shard);
  const seed = getSeed(config, state, currentEpoch);
  let i = 0;
  /* eslint-disable-next-line no-constant-condition */
  while (true) {
    const candidateIndex = firstCommittee[(currentEpoch + i) % firstCommittee.length];
    const randByte = hash(Buffer.concat([
      seed,
      intToBytes(intDiv(i, 32), 8),
    ]))[i % 32];
    const effectiveBalance = state.validators[candidateIndex].effectiveBalance;
    if (effectiveBalance * 255n >= (config.params.MAX_EFFECTIVE_BALANCE * BigInt(randByte))) {
      return candidateIndex;
    }
    i += 1;
  }
}
