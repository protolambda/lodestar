import {IReputation} from "../IReputation";
import {Checkpoint, SignedBeaconBlock, Slot, Status, Root, BeaconBlocksByRangeRequest} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IReqResp} from "../../network";
import {ISlotRange} from "../interface";
import {IBeaconChain} from "../../chain";
import {chunkify, getBlockRange, isValidChainOfBlocks} from "./blocks";
import {ILogger} from "@chainsafe/lodestar-utils/lib/logger";
import {toHexString} from "@chainsafe/ssz";
import {blockToHeader} from "@chainsafe/lodestar-beacon-state-transition";
import {RoundRobinArray} from "./robin";

export function getHighestCommonSlot(peers: IReputation[]): Slot {
  const slotStatuses = peers.reduce<Map<Slot, number>>((current, peer) => {
    if(peer.latestStatus && current.has(peer.latestStatus.headSlot)) {
      current.set(peer.latestStatus.headSlot, current.get(peer.latestStatus.headSlot) + 1);
    } else if(peer.latestStatus) {
      current.set(peer.latestStatus.headSlot, 1);
    }
    return current;
  }, new Map<Slot, number>());
  if(slotStatuses.size) {
    const best =  [...slotStatuses.entries()]
      .sort((a, b) => b[1] - a[1]);
    return best[0][0];
  } else {
    return 0;
  }
}

export function getStatusFinalizedCheckpoint(status: Status): Checkpoint {
  return {epoch: status.finalizedEpoch, root: status.finalizedRoot};
}

export function getCommonFinalizedCheckpoint(config: IBeaconConfig, peers: IReputation[]): Checkpoint|null {
  const checkpointVotes = peers.reduce<Map<string, {checkpoint: Checkpoint; votes: number}>>(
    (current, peer) => {
      if(!peer.latestStatus) {
        return current; 
      }
      const peerCheckpoint = getStatusFinalizedCheckpoint(peer.latestStatus);
      const root = toHexString(config.types.Checkpoint.hashTreeRoot(peerCheckpoint));
      if(current.has(root)) {
        current.get(root).votes++;
      } else {
        current.set(root, {checkpoint: peerCheckpoint, votes: 1});
      }
      return current;
    }, new Map());
  
  if(checkpointVotes.size > 0) {
    return Array.from(checkpointVotes.values())
      .sort((voteA, voteB) => {
        return voteB.votes - voteA.votes;
      }).shift().checkpoint;
  } else {
    return null;
  }
}

export function targetSlotToBlockStream(
  config: IBeaconConfig,
  chain: IBeaconChain,
  logger: ILogger,
  reqResp: IReqResp,
  getPeers: (minSlot: Slot) => Promise<PeerInfo[]>,
): (source: AsyncIterable<Slot>) => AsyncGenerator<SignedBeaconBlock[]> {
  return (source) => {
    return (async function*() {
      for await (const targetSlot of source) {
        const headState = await chain.getHeadState();

        // get a starting anchor root, to know we are on the right chain, and validate we didn't leave a gap.
        const headHeader = config.types.BeaconBlockHeader.clone(headState.latestBlockHeader);
        headHeader.stateRoot = config.types.BeaconState.hashTreeRoot(headState);
        const headBlockRoot = config.types.BeaconBlockHeader.hashTreeRoot(headHeader);

        // The slot we'll be syncing from
        const currentSlot = headState.slot + 1;

        if (targetSlot <= currentSlot) {
          continue;
        }
        // Assuming target-slot is incremented in medium spans, and not immediately chain head,
        // then peers will also be selected gradually, and
        const peers = await getPeers(targetSlot);
        const peerBalancer = new RoundRobinArray(peers);

        // TODO: shuffle peers, grow/shrink peer balances with disconnected/connected peers every now and then.

        // If this function is called repetitively with target-slots of medium distance from head,
        // then peer refreshing is probably not necessary, as we get a new peer balancer often enough.


        // collect a resulting array of signed beacon blocks for the requested target slot.
        const batch: SignedBeaconBlock[] = [];
        // keep track of progress
        let progressSlot = currentSlot;
        let progressRoot = headBlockRoot;
        while(progressSlot < targetSlot) {

          // Get candidates for syncing a mini batch from.
          // Max 3, we don't want to split requests between too many, or the weakest link effect is too bad.
          const candidates: PeerInfo[] = [];
          // TODO make maximum candidates (i.e. parallelism) configurable
          const canidateCount = Math.min(3, peers.length);
          for (let p = 0; p < canidateCount; p++) {
            candidates.push(peerBalancer.next());
          }
          const slotRange: ISlotRange = {start: progressSlot, end: targetSlot};
          // A mini batch is best-case a full batch, but if peers stop sending more chunks after a few blocks,
          // we'll have to take it as a smaller piece of progress, and continue from there
          const miniBatch = await fetchBlockTowardsTargetSlot(
            config, chain, logger, reqResp, candidates, progressRoot, slotRange);

          if (miniBatch.length > 0) {
            batch.push(...miniBatch);
            const lastBlock = miniBatch[miniBatch.length-1];
            progressSlot = lastBlock.message.slot + 1;
            progressRoot = config.types.BeaconBlock.hashTreeRoot(lastBlock.message);
          } else {
            // TODO: count retries, then assume many consecutive empty slots alternatively,
            // and having to move forward progressRoot forward.
          }
        }
        yield batch;
      }
    })();
  };
}

// Fetches batch of blocks, of any size, as far as can be consistent between peers
export async function fetchBlockTowardsTargetSlot(
  config: IBeaconConfig,
  chain: IBeaconChain,
  logger: ILogger,
  reqResp: IReqResp,
  peers: PeerInfo[],
  startRoot: Root,
  slotRange: ISlotRange,
): Promise<SignedBeaconBlock[]> {
  if (peers.length === 0) {
    // TODO: maybe sleep to give a chance to wait for peers to connect before trying again?
    return [];
  }
  // TODO make this configurable
  const batchTargetSize = 60;

  const step = peers.length;
  const count = Math.ceil(batchTargetSize / step);

  const batch: SignedBeaconBlock[] = [];

  await Promise.all(peers.map(async (peer, i) => {
    let offset = slotRange.start + i;
    // TODO: can cache ranges/offset/step combinations to do
    // less work when there's one bad peer that forms the weakest link.
    // Then skip the request, or make it smaller by skipping those already known starting blocks,
    // using blocks from the cache.
    const req: BeaconBlocksByRangeRequest = {
      startSlot: offset,
      step: step,
      count: count,
    };
    const chunkBlocks: SignedBeaconBlock[] = [];
    try {
      chunkBlocks.push(...(await reqResp.beaconBlocksByRange(peer, req) as SignedBeaconBlock[]));
    } catch(e) {
      logger.verbose(`failed to request block range from ${peer.id.toString()}, req: ${req}: ${e}`);
    }
    let chunkIndex = 0;
    for(const block of chunkBlocks) {
      // check min bound
      if(block.message.slot < offset) {
        logger.warn(`response chunk ${chunkIndex} (slot ${block.message.slot}) had too low slot`);
        break;
      }
      // check max bound
      if(block.message.slot > offset + batchTargetSize) {
        logger.warn(`response chunk ${chunkIndex} (slot ${block.message.slot}) had too high slot`);
        break;
      }
      // check step correctness
      if (((block.message.slot - offset) % step) !== i) {
        logger.warn(`response chunk ${chunkIndex} (slot ${block.message.slot})`
            +` has invalid stride (i: ${i}, step: ${step})`);
        break;
      }
      offset = block.message.slot;
      chunkIndex += 1;
      batch.push(block);
    }
  }));
  if (batch.length === 0) {
    return [];
  }
  // Sort the blocks, the collection work was async and blocks may be out of order.
  const sortedBatch = sortBlocks(batch);

  // Collect the starting part of the responses that is consistent, i.e. no missing blocks
  let prevBlockRoot = startRoot;
  const consistentBatch: SignedBeaconBlock[] = [];
  for (const block of sortedBatch) {
    if(!config.types.Root.equals(prevBlockRoot, block.message.parentRoot)) {
      break;
    }
    prevBlockRoot = config.types.BeaconBlock.hashTreeRoot(block.message);
    consistentBatch.push(block);
  }

  return consistentBatch;
}

export function sortBlocks(blocks: SignedBeaconBlock[]): SignedBeaconBlock[] {
  return blocks.sort((b1, b2) => b1.message.slot - b2.message.slot);
}

export function targetSlotToBlockChunks(
  config: IBeaconConfig, chain: IBeaconChain
): (source: AsyncIterable<Slot>) => AsyncGenerator<ISlotRange> {
  return (source) => {
    return (async function*() {
      for await (const targetSlot of source) {
        yield* chunkify(config.params.SLOTS_PER_EPOCH, (await chain.getHeadState()).slot + 1, targetSlot);
      }
    })();
  };
}



export function fetchBlockChunks(
  chain: IBeaconChain,
  reqResp: IReqResp,
  getPeers: (minSlot: Slot) => Promise<PeerInfo[]>,
  blocksPerChunk = 10
): (source: AsyncIterable<ISlotRange>,) => AsyncGenerator<SignedBeaconBlock[]> {
  return (source) => {
    return (async function*() {
      for await (const blockRange of source) {
        const peers = await getPeers(
          blockRange.end
        );
        if(peers.length > 0) {
          yield await getBlockRange(
            reqResp,
            peers,
            blockRange,
            blocksPerChunk
          );
        }
      }
    })();
  };
}

export function validateBlocks(
  config: IBeaconConfig, chain: IBeaconChain, logger: ILogger, onBlockVerificationFail: Function
): (source: AsyncIterable<SignedBeaconBlock[]>) => AsyncGenerator<SignedBeaconBlock[]> {
  return (source) => {
    return (async function*() {
      for await (const blockChunk of source) {
        if(blockChunk.length === 0) {
          continue;
        }
        const head =  blockToHeader(config, (await chain.getHeadBlock()).message);
        if(
          isValidChainOfBlocks(
            config,
            head,
            blockChunk
          )
        ) {
          yield blockChunk;
        } else {
          logger.warn(
            "Hash chain doesnt match! " 
              + `Head(${head.slot}): ${toHexString(config.types.BeaconBlockHeader.hashTreeRoot(head))}`
              + `Blocks: (${blockChunk[0].message.slot}..${blockChunk[blockChunk.length - 1].message.slot})`
          );
          //discard blocks and trigger resync so we try to fetch blocks again
          onBlockVerificationFail();
        }
      }
    })();
  };
}

export function processSyncBlocks(
  chain: IBeaconChain, logger: ILogger, trusted = false
): (source: AsyncIterable<SignedBeaconBlock[]>) => void {
  return async (source) => {
    for await (const blocks of source) {
      await Promise.all(blocks.map((block) => chain.receiveBlock(block, trusted)));
      if(blocks.length > 0) {
        logger.info(`Imported blocks ${blocks[0].message.slot}....${blocks[blocks.length - 1].message.slot}`);
      }
    }
  };
}