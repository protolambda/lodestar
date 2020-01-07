import {IRegularSync, IRegularSyncModules} from "../interface";
import {INetwork} from "../../../network";
import {IBeaconChain} from "../../../chain";
import {getHighestCommonSlot, isValidChainOfBlocks} from "../../utils/sync";
import {ReputationStore} from "../../reputation";
import {ILogger} from "../../../logger";
import {ATTESTATION_TOPIC, BLOCK_TOPIC} from "../../../constants";
import {Attestation, BeaconBlock, Slot} from "@chainsafe/eth2.0-types";
import {hashTreeRoot} from "@chainsafe/ssz";
import {IBeaconConfig} from "@chainsafe/eth2.0-config";
import {IBeaconDb} from "../../../db/api";
import {OpPool} from "../../../opPool";
import {computeEpochOfSlot, computeStartSlotOfEpoch} from "@chainsafe/eth2.0-state-transition";
import {getBlockRange} from "../../utils/blocks";
import {defaultOptions, IRegularSyncOptions} from "../options";
import deepmerge from "deepmerge";

export class NaiveRegularSync implements IRegularSync {

  private readonly config: IBeaconConfig;

  private readonly db: IBeaconDb;

  private readonly opPool: OpPool;

  private readonly network: INetwork;

  private readonly chain: IBeaconChain;

  private readonly reps: ReputationStore;

  private readonly peers: PeerInfo[];

  private readonly logger: ILogger;

  private readonly opts: IRegularSyncOptions;
  
  private targetSlot: Slot;

  constructor(options: Partial<IRegularSyncOptions>, modules: IRegularSyncModules) {
    this.config = modules.config;
    this.db = modules.db;
    this.opPool = modules.opPool;
    this.network = modules.network;
    this.chain = modules.chain;
    this.peers = modules.peers;
    this.reps = modules.reps;
    this.logger = modules.logger;
    this.opts = deepmerge(defaultOptions, options);
  }

  public async start(): Promise<void> {
    this.logger.info("Started regular syncing");
    this.chain.on("processedBlock", this.onProcessedBlock);
    this.startGossiping();
    if(!await this.syncUp()) {
      this.logger.info("Started subscribing to gossip topics...");
      this.chain.removeListener("processedBlock", this.onProcessedBlock);
    }
  }

  public async stop(): Promise<void> {
    this.chain.removeListener("processedBlock", this.onProcessedBlock);
    this.network.gossip.unsubscribeToBlocks();
    this.network.gossip.unsubscribeToAttestations();
    this.network.gossip.removeListener(BLOCK_TOPIC, this.receiveBlock);
    this.network.gossip.removeListener(ATTESTATION_TOPIC, this.receiveAttestation);
  }

  private startGossiping(): void {
    this.network.gossip.subscribeToBlocks();
    this.network.gossip.subscribeToAttestations();
    this.network.gossip.on(BLOCK_TOPIC, this.receiveBlock);
    this.network.gossip.on(ATTESTATION_TOPIC, this.receiveAttestation);
  }

  /**
     * @return false if it's already synced up, true if submitted blocks for chain processing
     */
  private async syncUp(): Promise<boolean> {
    const latestState = this.chain.latestState;
    const currentSlot = latestState.slot;
    const highestCommonSlot = getHighestCommonSlot(
      Array.from(this.peers).map((peer) => this.reps.getFromPeerInfo(peer))
    );
    console.log("Highest slot", highestCommonSlot);
    if (currentSlot >= highestCommonSlot) {
      this.logger.info("Chain already synced!");
      return false;
    }
    if(computeEpochOfSlot(this.config, currentSlot) < computeEpochOfSlot(this.config, highestCommonSlot)) {
      this.targetSlot = computeStartSlotOfEpoch(this.config, computeEpochOfSlot(this.config, currentSlot)  + 1);
    } else {
      this.targetSlot = highestCommonSlot;
    }
    this.logger.info(`Syncing slots ${currentSlot}...${this.targetSlot + 1}`);
    const blocks = await getBlockRange(
      this.network.reqResp,
      this.reps,
      this.peers,
      {start: currentSlot, end: this.targetSlot + 1},
      this.opts.blockPerChunk
    );
    if(isValidChainOfBlocks(this.config, await this.db.block.getBlockBySlot(latestState.slot), blocks)) {
      this.logger.info(`Processing blocks for slots ${currentSlot}...${this.targetSlot + 1}`);
      blocks.forEach((block) => this.chain.receiveBlock(block, false));
    } else {
      this.logger.warn(`Received invalid chain  of blocks for slots ${currentSlot}...${this.targetSlot + 1}`);
      this.syncUp();
    }
    return true;
  }

  private onProcessedBlock = async (block: BeaconBlock): Promise<void> => {
    if (this.targetSlot > block.slot) {
      return;
    }
    //synced to target, try new target or start gossiping;
    if(await this.syncUp()) {

      this.logger.important("Synced up!");
    }
  };

  private receiveBlock = async (block: BeaconBlock): Promise<void> => {
    console.log("Received gossiped block for slot ", block.slot);
    const root = hashTreeRoot(this.config.types.BeaconBlock, block);

    // skip block if its a known bad block
    if (await this.db.block.isBadBlock(root)) {
      this.logger.warn(`Received bad block, block root : ${root} `);
      return;
    }
    // skip block if it already exists
    if (!await this.db.block.has(root)) {
      await this.chain.receiveBlock(block);
    }
  };

  private receiveAttestation = async (attestation: Attestation): Promise<void> => {
    // skip attestation if it already exists
    const root = hashTreeRoot(this.config.types.Attestation, attestation);
    if (await this.db.attestation.has(root)) {
      return;
    }
    // skip attestation if its too old
    const state = await this.db.state.getLatest();
    if (attestation.data.target.epoch < state.finalizedCheckpoint.epoch) {
      return;
    }
    // send attestation on to other modules
    await Promise.all([
      this.opPool.attestations.receive(attestation),
      this.chain.receiveAttestation(attestation),
    ]);
  };
}