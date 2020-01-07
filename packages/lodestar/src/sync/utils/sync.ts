import {IReputation, ReputationStore} from "../reputation";
import {BeaconBlock, Checkpoint, Epoch, Slot} from "@chainsafe/eth2.0-types";
import {IBeaconConfig} from "@chainsafe/eth2.0-config";
import {signingRoot} from "@chainsafe/ssz";
import {IReqResp} from "../../network";
import {intDiv, toHex} from "@chainsafe/eth2.0-utils";

export function isValidChainOfBlocks(config: IBeaconConfig, start: BeaconBlock, blocks: BeaconBlock[]): boolean {
  let parentRoot = signingRoot(config.types.BeaconBlock, start);
  for(const block of blocks) {
    console.log("parent", toHex(parentRoot));
    console.log("current block parent", toHex(block.parentRoot));
    if(!parentRoot.equals(block.parentRoot)) {
      return false;
    }
    parentRoot = signingRoot(config.types.BeaconBlock, block);
  }
  return true;
}

export function getFastSyncTargetEpoch(peers: IReputation[], currentCheckPoint: Checkpoint): Epoch {
  const numberOfEpochToBatch = 1;
  const peersWithHigherFinalizedEpoch = peers.filter(peer => {
    if(!peer.latestHello) {
      return false;
    }
    if(peer.latestHello.finalizedEpoch > currentCheckPoint.epoch) {
      return true;
    }
  });
  if(peersWithHigherFinalizedEpoch.length > 0) {
    return currentCheckPoint.epoch + numberOfEpochToBatch;
  }
  return currentCheckPoint.epoch;
}

export function getHighestCommonSlot(peers: IReputation[]): Slot {
  const slotStatuses = peers.reduce<Map<Slot, number>>((current, peer) => {
    if(peer.latestHello && current.has(peer.latestHello.headSlot)) {
      current.set(peer.latestHello.headSlot + 1, current.get(peer.latestHello.headSlot) + 1);
    } else if(peer.latestHello) {
      current.set(peer.latestHello.headSlot + 1, 1);
    }
    return current;
  }, new Map<Slot, number>());
  return [...slotStatuses.entries()].sort((a, b) => {
    return a[1] - b[1];
  })[0][0];
}

export function isSynced(slot: Slot, peers: IReputation[]): boolean {
  return slot >= getHighestCommonSlot(peers);
}

export function isValidFinalizedCheckPoint(peers: IReputation[], finalizedCheckPoint: Checkpoint): boolean {
  const validPeers = peers.filter((peer) => !!peer.latestHello);
  const peerCount = validPeers.filter(peer => {
    return peer.latestHello.finalizedRoot.equals(finalizedCheckPoint.root);
  }).length;
  return peerCount >= intDiv(validPeers.length, 2);
}

export interface ISlotRange {
  start: Slot;
  end: Slot;
}

/**
 * Creates slot chunks returned chunks represents (inclusive) start and (inclusive) end slot
 * which should be fetched along all slotS(blocks) in between
 * @param blocksPerChunk
 * @param currentSlot
 * @param targetSlot
 */
export function chunkify(blocksPerChunk: number, currentSlot: Slot, targetSlot: Slot): ISlotRange[] {
  const chunks: ISlotRange[] = [];
  //currentSlot is our state slot so we need block from next slot
  for(let i = currentSlot + 1; i < targetSlot; i  = i + blocksPerChunk) {
    if(i + blocksPerChunk > targetSlot) {
      chunks.push({
        start: i,
        end: targetSlot
      });
    } else {
      chunks.push({
        start: i,
        end: i + blocksPerChunk - 1
      });
    }
  }
  return chunks;
}


export async function getBlockRangeFromPeer(
  rpc: IReqResp,
  reps: ReputationStore,
  peer: PeerInfo,
  chunk: ISlotRange
): Promise<BeaconBlock[]> {
  const peerLatestHello = reps.get(peer.id.toB58String()).latestHello;
  return await rpc.beaconBlocksByRange(
    peer,
    {
      headBlockRoot: peerLatestHello.headRoot,
      startSlot: chunk.start,
      step: 1,
      count: chunk.end - chunk.start
    }
  );
}
