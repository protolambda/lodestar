/**
 * @module sync
 */

import {EventEmitter} from "events";
import {IBeaconConfig} from "@chainsafe/eth2.0-config";
import {IBeaconChain} from "../chain";
import {INetwork} from "../network";
import {OpPool} from "../opPool";
import {IEth1Notifier} from "../eth1";
import {IBeaconDb} from "../db";
import {FastSync, InitialSync} from "./initial";
import {ILogger} from "../logger";
import {ISyncOptions} from "./options";
import {ISyncReqResp, SyncReqResp} from "./reqResp";
import {ReputationStore} from "./reputation";
import {Hash} from "@chainsafe/eth2.0-types";
import {IRegularSync} from "./regular/interface";
import {NaiveRegularSync} from "./regular/naive/naive";

export interface ISyncModules {
  config: IBeaconConfig;
  chain: IBeaconChain;
  db: IBeaconDb;
  eth1: IEth1Notifier;
  network: INetwork;
  opPool: OpPool;
  reps: ReputationStore;
  logger: ILogger;
}

/**
 * The Sync service syncing data between the network and the local chain
 * The strategy may differ depending on whether the chain is synced or not
 */
export class Sync extends EventEmitter {
  private opts: ISyncOptions;
  private config: IBeaconConfig;
  private chain: IBeaconChain;
  private network: INetwork;
  private opPool: OpPool;
  private reqResp: ISyncReqResp;
  private reps: ReputationStore;
  private logger: ILogger;
  //array of valid peers (peer on same fork)
  private peers: PeerInfo[] = [];
  private regularSync: IRegularSync;
  private initialSync: InitialSync;
  private waitingForPeer = true;

  public constructor(opts: ISyncOptions, modules: ISyncModules) {
    super();
    this.opts = opts;
    this.config = modules.config;
    this.chain = modules.chain;
    this.network = modules.network;
    this.opPool = modules.opPool;
    this.reps = modules.reps;
    this.logger = modules.logger;
    this.reqResp = new SyncReqResp(opts, modules);
    this.regularSync = new NaiveRegularSync(
      this.opts,
      {
        ...modules,
        //let it keep reference to peers
        peers: this.peers
      }
    );
    this.initialSync = new FastSync(
      this.opts,
      {
        ...modules,
        //let it keep reference to peers
        peers: this.peers
      }
    );
  }

  public async start(): Promise<void> {
    await this.reqResp.start();
    this.chain.on("unknownBlockRoot", this.onUnknownBlockRoot);
    this.initialSync.on("sync:completed", this.startRegularSync);
    //this.regularSync.on("fallenBehind", this.startInitialSync);
    this.peers.concat(this.getValidPeers());
    this.network.on("peer:disconnect", this.handleLostPeer);
    this.network.on("peer:connect", this.handleNewPeer);
    this.startInitialSync();
  }

  public async stop(): Promise<void> {
    await this.reqResp.stop();
    this.chain.removeListener("unknownBlockRoot", this.onUnknownBlockRoot);
    this.initialSync.removeListener("sync:completed", this.startRegularSync);
    this.network.removeListener("peer:disconnect", this.handleLostPeer);
    this.network.removeListener("peer:connect", this.handleNewPeer);
    await this.initialSync.stop();
    await this.regularSync.stop();
  }

  public isSynced(): boolean {
    return false;
  }

  private startRegularSync = async (): Promise<void> => {
    this.initialSync.removeListener("sync:completed", this.startRegularSync);
    await this.initialSync.stop();
    this.regularSync.start();
  };

  private startInitialSync = (): void => {
    if(this.getValidPeers().length >= 1) {
      this.waitingForPeer = false;
      this.initialSync.start();
    } else {
      this.logger.warn("No peers. Waiting to connect to peer...");
      setTimeout(this.startInitialSync, 2000);
    }
  };

  private getValidPeers(): PeerInfo[] {
    //TODO: filter and drop peers on different fork
    return this.network.getPeers().filter((peer) => {
      return !!(this.reps.get(peer.id.toB58String()).latestHello);
    });
  }

  private handleNewPeer = (peer: PeerInfo): void => {
    //TODO: check if peer is useful
    this.peers.push(peer);
  };

  private onUnknownBlockRoot = async (root: Hash): Promise<void> => {
    for (const peer of this.peers) {
      try {
        this.logger.verbose(`Attempting to fetch block ${root.toString("hex")} from ${peer.id.toB58String()}`);
        const [block] = await this.network.reqResp.beaconBlocksByRoot(peer, [root]);
        await this.chain.receiveBlock(block);
        break;
      } catch (e) {
        this.logger.verbose(`Unable to fetch block ${root.toString("hex")}: ${e}`);
      }
    }
  };

  private handleLostPeer = (peer: PeerInfo): void => {
    const index = this.peers.findIndex((existingPeer) => {
      return existingPeer.id.toBytes().equals(peer.id.toBytes());
    });
    if (index > -1) {
      this.peers.splice(index, 1);
    }
  };
}
