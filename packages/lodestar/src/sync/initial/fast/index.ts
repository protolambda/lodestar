/**
 * @module sync/initial
 */
import {IBeaconConfig} from "@chainsafe/eth2.0-config";
import {IBeaconChain} from "../../../chain";
import {ReputationStore} from "../../reputation";
import {INetwork, IReqResp} from "../../../network";
import {ILogger} from "../../../logger";
import {ISyncOptions} from "../../options";
import {IInitialSyncModules, InitialSync, InitialSyncEventEmitter} from "../interface";
import {EventEmitter} from "events";
import {getFastSyncTargetEpoch, isValidChainOfBlocks, isValidFinalizedCheckPoint} from "../../utils/sync";
import {BeaconState, Checkpoint} from "@chainsafe/eth2.0-types";
import {computeStartSlotOfEpoch} from "@chainsafe/eth2.0-state-transition";
import {getBlockRange} from "../../utils/blocks";
import {IBeaconDb} from "../../../db/api";

export class FastSync
  extends (EventEmitter as { new(): InitialSyncEventEmitter })
  implements InitialSync {

  private readonly config: IBeaconConfig;
  private readonly opts: ISyncOptions;
  private readonly chain: IBeaconChain;
  private readonly db: IBeaconDb;
  private readonly reps: ReputationStore;
  private readonly network: INetwork;
  private readonly logger: ILogger;
  private readonly peers: PeerInfo[];

  public constructor(opts: ISyncOptions, modules: IInitialSyncModules) {
    super();
    this.config = modules.config;
    this.chain = modules.chain;
    this.db = modules.db;
    this.peers = modules.peers;
    this.reps = modules.reps;
    this.opts = opts;
    this.network = modules.network;
    this.logger = modules.logger;
  }

  public async start(): Promise<void> {
    this.logger.info("initial sync start");
    if(this.peers.length === 0) {
      this.logger.error("No peers. Exiting initial sync");
      return;
    }
    if(!this.chain.isInitialized()) {
      this.logger.warn("Chain not initialized.");
      this.emit("sync:completed", null);
      return;
    }

    const chainCheckPoint = this.chain.latestState.currentJustifiedCheckpoint;
    //listen on finalization events
    this.chain.on("processedCheckpoint", this.sync);
    //start syncing from current chain checkpoint
    await this.sync(chainCheckPoint);
  }

  public async stop(): Promise<void> {
    this.logger.info("initial sync stop");
    this.chain.removeListener("processedCheckpoint", this.sync);
  }

  private sync = async (chainCheckPoint: Checkpoint): Promise<void> => {
    const peers = Array.from(this.peers).map((peer) => this.reps.getFromPeerInfo(peer));
    const targetEpoch = getFastSyncTargetEpoch(peers, chainCheckPoint);
    this.logger.info(`Current epoch ${chainCheckPoint.epoch}. Syncing up to epoch ${targetEpoch}`);
    if(chainCheckPoint.epoch >= targetEpoch) {
      if(isValidFinalizedCheckPoint(peers, chainCheckPoint)) {
        this.logger.info("Chain already on latest finalized state");
        this.chain.removeListener("processedCheckpoint", this.sync);
        this.emit("sync:completed", chainCheckPoint);
        return;
      }
      this.logger.error("Wrong chain synced, should clean and start over");
    } else {
      this.logger.info(`Fast syncing to target epoch ${targetEpoch}`);
      const latestState = this.chain.latestState as BeaconState;
      const blocks = await getBlockRange(
        this.network.reqResp,
        this.reps,
        this.peers,
        {start: latestState.slot, end: computeStartSlotOfEpoch(this.config, targetEpoch) + 1},
        this.opts.blockPerChunk
      );
      if(isValidChainOfBlocks(this.config, await this.db.block.getBlockBySlot(latestState.slot), blocks)) {
        blocks.forEach((block) => this.chain.receiveBlock(block, true));
        this.emit("sync:checkpoint", targetEpoch);
      } else {
        //TODO: if finalized checkpoint is wrong, sync whole chain again
        this.logger.error(`Invalid header chain (${latestState.slot}...`
            + `${computeStartSlotOfEpoch(this.config, targetEpoch)}), blocks discarded. Retrying...`
        );
        await this.sync(chainCheckPoint);
      }
    }
  };


}
