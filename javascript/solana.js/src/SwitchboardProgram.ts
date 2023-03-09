import {
  BUFFER_DISCRIMINATOR,
  CrankAccount,
  DISCRIMINATOR_MAP,
  JobAccount,
  ProgramStateAccount,
  QueueAccount,
  SwitchboardAccountData,
  SwitchboardAccountType,
} from './accounts';
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  SWITCHBOARD_LABS_DEVNET_PERMISSIONED_CRANK,
  SWITCHBOARD_LABS_DEVNET_PERMISSIONED_QUEUE,
  SWITCHBOARD_LABS_DEVNET_PERMISSIONLESS_CRANK,
  SWITCHBOARD_LABS_DEVNET_PERMISSIONLESS_QUEUE,
  SWITCHBOARD_LABS_MAINNET_PERMISSIONED_CRANK,
  SWITCHBOARD_LABS_MAINNET_PERMISSIONED_QUEUE,
  SWITCHBOARD_LABS_MAINNET_PERMISSIONLESS_CRANK,
  SWITCHBOARD_LABS_MAINNET_PERMISSIONLESS_QUEUE,
} from './const';
import * as errors from './errors';
import {
  AggregatorAccountData,
  BufferRelayerAccountData,
  CrankAccountData,
  JobAccountData,
  LeaseAccountData,
  OracleAccountData,
  OracleQueueAccountData,
  PermissionAccountData,
  SbState,
  SlidingResultAccountData,
  VrfAccountData,
} from './generated';
import { NativeMint } from './mint';
import { SwitchboardEvents } from './SwitchboardEvents';
import { TransactionObject, TransactionOptions } from './TransactionObject';
import { LoadedJobDefinition } from './types';

import * as anchor from '@coral-xyz/anchor';
import { ACCOUNT_DISCRIMINATOR_SIZE } from '@coral-xyz/anchor';
import {
  AccountInfo,
  Cluster,
  ConfirmOptions,
  Connection,
  Keypair,
  PublicKey,
  SendOptions,
  Transaction,
  TransactionSignature,
} from '@solana/web3.js';
import { OracleJob } from '@switchboard-xyz/common';

export type SendTransactionOptions = (ConfirmOptions | SendOptions) & {
  skipConfrimation?: boolean;
};
export const DEFAULT_SEND_TRANSACTION_OPTIONS: SendTransactionOptions = {
  skipPreflight: false,
  maxRetries: 10,
  skipConfrimation: false,
};

/**
 * Switchboard Devnet Program ID
 */
export const SBV2_DEVNET_PID = new PublicKey(
  '2TfB33aLaneQb5TNVwyDz3jSZXS6jdW2ARw1Dgf84XCG'
);

/**
 * Switchboard Mainnet Program ID
 */
export const SBV2_MAINNET_PID = new PublicKey(
  'SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f'
);

/**
 *  A generated keypair that is assigned as the _payerKeypair_ when in read-only mode.
 */
export const READ_ONLY_KEYPAIR = Keypair.generate();
/**
 * Returns the Switchboard Program ID for the specified Cluster.
 */
export const getSwitchboardProgramId = (
  cluster: Cluster | 'localnet'
): PublicKey => {
  switch (cluster) {
    case 'mainnet-beta':
      return SBV2_MAINNET_PID;
    case 'localnet':
    case 'devnet':
      return SBV2_DEVNET_PID;
    case 'testnet':
    default:
      throw new Error(`Switchboard PID not found for cluster (${cluster})`);
  }
};

/**
 * Wrapper class for the Switchboard anchor Program.
 *
 * Basic usage example:
 *
 * ```ts
 * import { Connection } from "@solana/web3.js";
 * import { SwitchboardProgram, TransactionObject } from '@switchboard-xyz/solana.js';
 *
 * const program = await SwitchboardProgram.load(
 *    "mainnet-beta",
 *    new Connection("https://api.mainnet-beta.solana.com"),
 *    payerKeypair
 * );
 *
 * const txn = new TransactionObject(program.walletPubkey, [], []);
 * const txnSignature = await program.signAndSend(txn);
 * ```
 */
export class SwitchboardProgram {
  private static readonly _readOnlyKeypair = READ_ONLY_KEYPAIR;

  private readonly _program: anchor.Program;

  /** The solana cluster to load the Switchboard program for. */
  readonly cluster: Cluster | 'localnet';

  readonly programState: {
    publicKey: PublicKey;
    bump: number;
  };

  readonly mint: NativeMint;

  /**
   * Constructor.
   */
  constructor(
    program: anchor.Program,
    cluster: Cluster | 'localnet',
    mint: NativeMint
  ) {
    this._program = program;
    this.cluster = cluster;

    const stateAccount = ProgramStateAccount.fromSeed(this);
    this.programState = {
      publicKey: stateAccount[0].publicKey,
      bump: stateAccount[1],
    };
    this.mint = mint;
  }

  static async loadAnchorProgram(
    cluster: Cluster | 'localnet',
    connection: Connection,
    payerKeypair: Keypair = READ_ONLY_KEYPAIR,
    programId?: PublicKey
  ): Promise<anchor.Program> {
    const pid = programId ?? getSwitchboardProgramId(cluster);
    const provider = new anchor.AnchorProvider(
      connection,
      // If no keypair is provided, default to dummy keypair
      new AnchorWallet(payerKeypair ?? SwitchboardProgram._readOnlyKeypair),
      { commitment: 'confirmed' }
    );
    const anchorIdl = await anchor.Program.fetchIdl(pid, provider);
    if (!anchorIdl) {
      throw new Error(`Failed to find IDL for ${pid.toBase58()}`);
    }
    const program = new anchor.Program(anchorIdl, pid, provider);

    return program;
  }

  /**
   * Create and initialize a {@linkcode SwitchboardProgram} connection object.
   *
   * @param cluster - the solana cluster to load the Switchboard program for.
   *
   * @param connection - the Solana connection object used to connect to an RPC node.
   *
   * @param payerKeypair - optional, payer keypair used to pay for on-chain transactions.
   *
   * @param programId - optional, override the cluster's default programId.
   *
   * @return the {@linkcode SwitchboardProgram} used to create and interact with Switchboard accounts.
   *
   * Basic usage example:
   *
   * ```ts
   * import { Connection } from "@solana/web3.js";
   * import { SwitchboardProgram, TransactionObject } from '@switchboard-xyz/solana.js';
   *
   * const program = await SwitchboardProgram.load(
   *    "mainnet-beta",
   *    new Connection("https://api.mainnet-beta.solana.com"),
   *    payerKeypair
   * );
   *
   * const txn = new TransactionObject(program.walletPubkey, [], []);
   * const txnSignature = await program.signAndSend(txn);
   * ```
   */
  static load = async (
    cluster: Cluster | 'localnet',
    connection: Connection,
    payerKeypair: Keypair = READ_ONLY_KEYPAIR,
    programId: PublicKey = getSwitchboardProgramId(cluster)
  ): Promise<SwitchboardProgram> => {
    const program = await SwitchboardProgram.loadAnchorProgram(
      cluster,
      connection,
      payerKeypair,
      programId
    );
    const mint = await NativeMint.load(
      program.provider as anchor.AnchorProvider
    );
    return new SwitchboardProgram(program, cluster, mint);
  };

  /**
   * Create and initialize a {@linkcode SwitchboardProgram} connection object.
   *
   * @param provider - the anchor provider containing the rpc and wallet connection.
   *
   * @return the {@linkcode SwitchboardProgram} used to create and interact with Switchboard accounts.
   *
   * Basic usage example:
   *
   * ```ts
   * import * as anchor from "@coral-xyz/anchor";
   * import { Connection } from "@solana/web3.js";
   * import { AnchorWallet, SwitchboardProgram, TransactionObject } from '@switchboard-xyz/solana.js';
   *
   * const connection = new Connection("https://api.mainnet-beta.solana.com");
   * const provider = new anchor.AnchorProvider(
      connection,
      new AnchorWallet(payerKeypair ?? SwitchboardProgram._readOnlyKeypair),
      { commitment: 'confirmed' }
    );
   * const program = await SwitchboardProgram.fromProvider(provider);
   *
   * const txn = new TransactionObject(program.walletPubkey, [], []);
   * const txnSignature = await program.signAndSend(txn);
   * ```
   */
  static fromProvider = async (
    provider: anchor.AnchorProvider,
    programId?: PublicKey
  ): Promise<SwitchboardProgram> => {
    const payer = (provider.wallet as AnchorWallet).payer;
    const program = await SwitchboardProgram.fromConnection(
      provider.connection,
      payer,
      programId
    );
    return program;
  };

  /**
   * Create and initialize a {@linkcode SwitchboardProgram} connection object.
   *
   * @param provider - the anchor provider containing the rpc and wallet connection.
   *
   * @return the {@linkcode SwitchboardProgram} used to create and interact with Switchboard accounts.
   *
   * Basic usage example:
   *
   * ```ts
   * import * as anchor from "@coral-xyz/anchor";
   * import { Connection } from "@solana/web3.js";
   * import { AnchorWallet, SwitchboardProgram, TransactionObject } from '@switchboard-xyz/solana.js';
   *
   * const connection = new Connection("https://api.mainnet-beta.solana.com");
   * const program = await SwitchboardProgram.fromConnection(connection);
   * ```
   */
  static fromConnection = async (
    connection: Connection,
    payer = READ_ONLY_KEYPAIR,
    programId?: PublicKey
  ): Promise<SwitchboardProgram> => {
    const genesisHash = await connection.getGenesisHash();
    const cluster =
      genesisHash === MAINNET_GENESIS_HASH
        ? 'mainnet-beta'
        : genesisHash === DEVNET_GENESIS_HASH
        ? 'devnet'
        : 'localnet';

    let pid = programId;
    if (!pid) {
      pid =
        programId ?? cluster === 'mainnet-beta'
          ? SBV2_MAINNET_PID
          : cluster === 'devnet'
          ? SBV2_DEVNET_PID
          : SBV2_DEVNET_PID;
    }

    const programAccountInfo = await connection.getAccountInfo(pid);
    if (programAccountInfo === null) {
      throw new Error(
        `Failed to load Switchboard at ${pid}, try manually providing a programId`
      );
    }

    const program = await SwitchboardProgram.load(
      cluster,
      connection,
      payer,
      pid
    );
    return program;
  };

  /**
   * The Switchboard Program ID for the currently connected cluster.
   */
  public get programId(): PublicKey {
    return this._program.programId;
  }
  /**
   * The Switchboard Program IDL.
   */
  public get idl(): anchor.Idl {
    return this._program.idl;
  }
  /**
   * The Switchboard Program ID for the currently connected cluster.
   */
  public get coder(): anchor.BorshAccountsCoder {
    return new anchor.BorshAccountsCoder(this._program.idl);
  }
  /**
   * The anchor Provider used by this program to connect with Solana cluster.
   */
  public get provider(): anchor.AnchorProvider {
    return this._program.provider as anchor.AnchorProvider;
  }
  /**
   * The Connection used by this program to connect with Solana cluster.
   */
  public get connection(): Connection {
    return this._program.provider.connection;
  }
  /**
   * The Connection used by this program to connect with Solana cluster.
   */
  public get wallet(): AnchorWallet {
    return this.provider.wallet as AnchorWallet;
  }

  public get walletPubkey(): PublicKey {
    return this.wallet.payer.publicKey;
  }
  /**
   * Some actions exposed by this SDK require that a payer Keypair has been
   * provided to {@linkcode SwitchboardProgram} in order to send transactions.
   */
  public get isReadOnly(): boolean {
    return (
      this.provider.publicKey.toBase58() ===
      SwitchboardProgram._readOnlyKeypair.publicKey.toBase58()
    );
  }

  /** Verify a payer keypair was supplied. */
  public verifyPayer(): void {
    if (this.isReadOnly) {
      throw new errors.SwitchboardProgramReadOnlyError();
    }
  }

  /**
   * Verify a fresh keypair was provided.
   *
   * **NOTE:** Creating new accounts without this check will prevent the ability to remove any existing funds. */
  public async verifyNewKeypair(keypair: Keypair): Promise<void> {
    const accountInfo = await this.connection.getAccountInfo(keypair.publicKey);
    if (accountInfo) {
      throw new errors.ExistingKeypair();
    }
  }

  public get account(): anchor.AccountNamespace {
    return this._program.account;
  }

  /**
   * Load the Switchboard Labs permissionless Queue for either devnet or mainnet. The permissionless queue has the following permissions:
   *  - unpermissionedFeedsEnabled: True
   *  - unpermissionedVrfEnabled: True
   *  - enableBufferRelayers: False
   *
   * **Note:** {@linkcode AggregatorAccount}s and {@linkcode VrfAccount}s do not require permissions to join this queue. {@linkcode BufferRelayerAccount}s are disabled.
   */
  async loadPermissionless(): Promise<{
    queueAccount: QueueAccount;
    queue: OracleQueueAccountData;
    crankAccount: CrankAccount;
    crank: CrankAccountData;
  }> {
    const queueKey =
      this.cluster === 'mainnet-beta'
        ? SWITCHBOARD_LABS_MAINNET_PERMISSIONLESS_QUEUE
        : this.cluster === 'devnet'
        ? SWITCHBOARD_LABS_DEVNET_PERMISSIONLESS_QUEUE
        : null;
    if (!queueKey) {
      throw new Error(
        `Failed to load the permissionless queue for cluster ${this.cluster}`
      );
    }
    const [queueAccount, queue] = await QueueAccount.load(this, queueKey);

    const crankKey =
      this.cluster === 'mainnet-beta'
        ? SWITCHBOARD_LABS_MAINNET_PERMISSIONLESS_CRANK
        : this.cluster === 'devnet'
        ? SWITCHBOARD_LABS_DEVNET_PERMISSIONLESS_CRANK
        : null;
    if (!crankKey) {
      throw new Error(
        `Failed to load the permissionless queue for cluster ${this.cluster}`
      );
    }
    const [crankAccount, crank] = await CrankAccount.load(this, crankKey);

    return { queueAccount, queue, crankAccount, crank };
  }

  /**
   * Load the Switchboard Labs permissionled Queue for either devnet or mainnet. The permissioned queue has the following permissions:
   *  - unpermissionedFeedsEnabled: False
   *  - unpermissionedVrfEnabled: False
   *  - enableBufferRelayers: False
   *
   * **Note:** The queue authority must grant {@linkcode AggregatorAccount}s PERMIT_ORACLE_QUEUE_USAGE and {@linkcode VrfAccount}s PERMIT_VRF_REQUESTS permissions before joining the queue and requesting oracle updates. {@linkcode BufferRelayerAccount}s are disabled.
   */
  async loadPermissioned(): Promise<{
    queueAccount: QueueAccount;
    queue: OracleQueueAccountData;
    crankAccount: CrankAccount;
    crank: CrankAccountData;
  }> {
    const queueKey =
      this.cluster === 'mainnet-beta'
        ? SWITCHBOARD_LABS_MAINNET_PERMISSIONED_QUEUE
        : this.cluster === 'devnet'
        ? SWITCHBOARD_LABS_DEVNET_PERMISSIONED_QUEUE
        : null;
    if (!queueKey) {
      throw new Error(
        `Failed to load the permissioned queue for cluster ${this.cluster}`
      );
    }
    const [queueAccount, queue] = await QueueAccount.load(
      this,
      this.cluster === 'mainnet-beta'
        ? SWITCHBOARD_LABS_MAINNET_PERMISSIONED_QUEUE
        : SWITCHBOARD_LABS_DEVNET_PERMISSIONED_QUEUE
    );

    const crankKey =
      this.cluster === 'mainnet-beta'
        ? SWITCHBOARD_LABS_MAINNET_PERMISSIONED_CRANK
        : this.cluster === 'devnet'
        ? SWITCHBOARD_LABS_DEVNET_PERMISSIONED_CRANK
        : null;
    if (!crankKey) {
      throw new Error(
        `Failed to load the permissionless queue for cluster ${this.cluster}`
      );
    }
    const [crankAccount, crank] = await CrankAccount.load(this, crankKey);

    return { queueAccount, queue, crankAccount, crank };
  }

  public addEventListener<EventName extends keyof SwitchboardEvents>(
    eventName: EventName,
    callback: (
      data: SwitchboardEvents[EventName],
      slot: number,
      signature: string
    ) => void | Promise<void>
  ): number {
    return this._program.addEventListener(eventName as string, callback);
  }

  public async removeEventListener(listenerId: number) {
    return await this._program.removeEventListener(listenerId);
  }

  public async signAndSendAll(
    txns: Array<TransactionObject>,
    opts: SendTransactionOptions = DEFAULT_SEND_TRANSACTION_OPTIONS,
    txnOptions?: TransactionOptions,
    delay = 0
  ): Promise<Array<TransactionSignature>> {
    const txnSignatures = await TransactionObject.signAndSendAll(
      this.provider,
      txns,
      opts,
      txnOptions,
      delay
    );
    return txnSignatures;
  }

  public async signAndSend(
    txn: TransactionObject,
    opts: SendTransactionOptions = DEFAULT_SEND_TRANSACTION_OPTIONS,
    txnOptions?: TransactionOptions
  ): Promise<TransactionSignature> {
    const txnSignature = await txn.signAndSend(this.provider, opts, txnOptions);
    return txnSignature;
  }

  async getProgramJobAccounts(): Promise<Map<Uint8Array, LoadedJobDefinition>> {
    const accountInfos = await this.connection
      .getProgramAccounts(this.programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: anchor.utils.bytes.bs58.encode(
                JobAccountData.discriminator
              ),
            },
          },
        ],
      })
      .then((values: Array<AccountInfoResponse | undefined>) => {
        return values.filter(Boolean) as Array<AccountInfoResponse>;
      });

    const jobs: Array<LoadedJobDefinition> = accountInfos
      .map((job): LoadedJobDefinition | undefined => {
        const jobAccount = new JobAccount(this, job.pubkey);
        const state = JobAccountData.decode(job.account.data);
        let oracleJob: OracleJob;
        try {
          oracleJob = OracleJob.decodeDelimited(state.data);
        } catch {
          return undefined;
        }

        return {
          account: jobAccount,
          state: state,
          job: oracleJob,
        };
      })
      .filter(Boolean) as Array<LoadedJobDefinition>;

    return new Map(jobs.map(job => [job.state.data, job]));
  }

  async getProgramAccounts(): Promise<{
    aggregators: Map<string, AggregatorAccountData>;
    buffers: Map<string, Buffer>;
    bufferRelayers: Map<string, BufferRelayerAccountData>;
    cranks: Map<string, CrankAccountData>;
    jobs: Map<string, JobAccountData>;
    leases: Map<string, LeaseAccountData>;
    oracles: Map<string, OracleAccountData>;
    permissions: Map<string, PermissionAccountData>;
    programState: Map<string, SbState>;
    queues: Map<string, OracleQueueAccountData>;
    slidingResult: Map<string, SlidingResultAccountData>;
    vrfs: Map<string, VrfAccountData>;
  }> {
    const accountInfos: Array<AccountInfoResponse> =
      await this.connection.getProgramAccounts(this.programId);

    // buffer - [42, 55, 46, 46, 45, 52, 78, 78]
    // bufferRelayer - [50, 35, 51, 115, 169, 219, 158, 52]
    // lease - [55, 254, 208, 251, 164, 44, 150, 50]
    // permissions - [77, 37, 177, 164, 38, 39, 34, 109]
    // slidingResult - [91, 4, 83, 187, 102, 216, 153, 254]
    // vrf - [101, 35, 62, 239, 103, 151, 6, 18]
    // crank - [111, 81, 146, 73, 172, 180, 134, 209]
    // job - [124, 69, 101, 195, 229, 218, 144, 63]
    // oracles - [128, 30, 16, 241, 170, 73, 55, 54]
    // sbState - [159, 42, 192, 191, 139, 62, 168, 28]
    // queue - [164, 207, 200, 51, 199, 113, 35, 109]
    // aggregator - [217, 230, 65, 101, 201, 162, 27, 125]

    const discriminatorMap: Map<
      string,
      Array<AccountInfoResponse>
    > = accountInfos.reduce((map, account) => {
      const discriminator = account.account.data
        .slice(0, ACCOUNT_DISCRIMINATOR_SIZE)
        .toString('utf-8');

      const accounts = map.get(discriminator) ?? [];
      accounts.push(account);
      map.set(discriminator, accounts);

      return map;
    }, new Map<string, Array<AccountInfoResponse>>());

    function decodeAccounts<T extends SwitchboardAccountData>(
      accounts: Array<AccountInfoResponse>,
      decode: (data: Buffer) => T
    ): Map<string, T> {
      return accounts.reduce((map, account) => {
        try {
          const decoded = decode(account.account.data);
          map.set(account.pubkey.toBase58(), decoded);
          // eslint-disable-next-line no-empty
        } catch {}

        return map;
      }, new Map<string, T>());
    }

    const aggregators: Map<string, AggregatorAccountData> = decodeAccounts(
      discriminatorMap.get(
        AggregatorAccountData.discriminator.toString('utf-8')
      ) ?? [],
      AggregatorAccountData.decode
    );

    // TODO: Use aggregator.historyBuffer, crank.dataBuffer, queue.dataBuffer to filter these down and decode
    const buffers: Map<string, Buffer> = (
      discriminatorMap.get(BUFFER_DISCRIMINATOR.toString('utf-8')) ?? []
    ).reduce((map, buffer) => {
      map.set(buffer.pubkey.toBase58(), buffer.account.data);
      return map;
    }, new Map<string, Buffer>());

    const bufferRelayers: Map<string, BufferRelayerAccountData> =
      decodeAccounts(
        discriminatorMap.get(
          BufferRelayerAccountData.discriminator.toString('utf-8')
        ) ?? [],
        BufferRelayerAccountData.decode
      );

    const cranks: Map<string, CrankAccountData> = decodeAccounts(
      discriminatorMap.get(CrankAccountData.discriminator.toString('utf-8')) ??
        [],
      CrankAccountData.decode
    );

    const jobs: Map<string, JobAccountData> = decodeAccounts(
      discriminatorMap.get(JobAccountData.discriminator.toString('utf-8')) ??
        [],
      JobAccountData.decode
    );

    const leases: Map<string, LeaseAccountData> = decodeAccounts(
      discriminatorMap.get(LeaseAccountData.discriminator.toString('utf-8')) ??
        [],
      LeaseAccountData.decode
    );

    const oracles: Map<string, OracleAccountData> = decodeAccounts(
      discriminatorMap.get(OracleAccountData.discriminator.toString('utf-8')) ??
        [],
      OracleAccountData.decode
    );

    const permissions: Map<string, PermissionAccountData> = decodeAccounts(
      discriminatorMap.get(
        PermissionAccountData.discriminator.toString('utf-8')
      ) ?? [],
      PermissionAccountData.decode
    );

    const programState: Map<string, SbState> = decodeAccounts(
      discriminatorMap.get(SbState.discriminator.toString('utf-8')) ?? [],
      SbState.decode
    );

    const queues: Map<string, OracleQueueAccountData> = decodeAccounts(
      discriminatorMap.get(
        OracleQueueAccountData.discriminator.toString('utf-8')
      ) ?? [],
      OracleQueueAccountData.decode
    );

    const slidingResult: Map<string, SlidingResultAccountData> = decodeAccounts(
      discriminatorMap.get(
        SlidingResultAccountData.discriminator.toString('utf-8')
      ) ?? [],
      SlidingResultAccountData.decode
    );

    const vrfs: Map<string, VrfAccountData> = decodeAccounts(
      discriminatorMap.get(VrfAccountData.discriminator.toString('utf-8')) ??
        [],
      VrfAccountData.decode
    );

    return {
      aggregators,
      buffers,
      bufferRelayers,
      cranks,
      jobs,
      leases,
      oracles,
      permissions,
      programState,
      slidingResult,
      queues,
      vrfs,
    };
  }

  static getAccountType(
    accountInfo: AccountInfo<Buffer>
  ): SwitchboardAccountType | null {
    const discriminator = accountInfo.data
      .slice(0, ACCOUNT_DISCRIMINATOR_SIZE)
      .toString('utf-8');
    const accountType = DISCRIMINATOR_MAP.get(discriminator);
    if (accountType) {
      return accountType;
    }

    return null;
  }
}

export class AnchorWallet implements anchor.Wallet {
  constructor(readonly payer: Keypair) {
    this.payer = payer;
  }
  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }
  private sign = (txn: Transaction): Transaction => {
    txn.partialSign(this.payer);
    return txn;
  };
  async signTransaction(txn: Transaction) {
    return this.sign(txn);
  }
  async signAllTransactions(txns: Transaction[]) {
    return txns.map(this.sign);
  }
}

interface AccountInfoResponse {
  pubkey: anchor.web3.PublicKey;
  account: anchor.web3.AccountInfo<Buffer>;
}
