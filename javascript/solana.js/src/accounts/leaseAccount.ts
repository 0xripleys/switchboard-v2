import * as anchor from '@project-serum/anchor';
import * as errors from '../errors';
import * as types from '../generated';
import { SwitchboardProgram } from '../program';
import { Account } from './account';
import * as spl from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionSignature,
} from '@solana/web3.js';
import { AggregatorAccount } from './aggregatorAccount';
import { QueueAccount } from './queueAccount';
import { TransactionObject } from '../transaction';
import { BN } from 'bn.js';

export class LeaseAccount extends Account<types.LeaseAccountData> {
  static accountName = 'LeaseAccountData';

  /**
   * Get the size of an {@linkcode LeaseAccount} on-chain.
   */
  public size = this.program.account.leaseAccountData.size;

  /**
   * Loads a LeaseAccount from the expected PDA seed format.
   * @param program The Switchboard program for the current connection.
   * @param queue The queue pubkey to be incorporated into the account seed.
   * @param aggregator The aggregator pubkey to be incorporated into the account seed.
   * @return LeaseAccount and PDA bump.
   */
  public static fromSeed(
    program: SwitchboardProgram,
    queue: PublicKey,
    aggregator: PublicKey
  ): [LeaseAccount, number] {
    const [publicKey, bump] = anchor.utils.publicKey.findProgramAddressSync(
      [Buffer.from('LeaseAccountData'), queue.toBytes(), aggregator.toBytes()],
      program.programId
    );
    return [new LeaseAccount(program, publicKey), bump];
  }

  /**
   * Retrieve and decode the {@linkcode types.LeaseAccountData} stored in this account.
   */
  public async loadData(): Promise<types.LeaseAccountData> {
    const data = await types.LeaseAccountData.fetch(
      this.program,
      this.publicKey
    );
    if (data === null) throw new errors.AccountNotFoundError(this.publicKey);
    return data;
  }

  static getWallets(
    jobAuthorities: Array<PublicKey>,
    mint: PublicKey
  ): {
    wallets: Array<{ publicKey: PublicKey; bump: number }>;
    walletBumps: Uint8Array;
  } {
    const wallets: Array<{ publicKey: PublicKey; bump: number }> = [];
    const walletBumps: Array<number> = [];

    for (const jobAuthority in jobAuthorities) {
      const authority = new PublicKey(jobAuthority);
      if (!jobAuthority || PublicKey.default.equals(authority)) {
        continue;
      }
      const [jobWallet, bump] = anchor.utils.publicKey.findProgramAddressSync(
        [
          authority.toBuffer(),
          spl.TOKEN_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );
      wallets.push({ publicKey: jobWallet, bump });
      walletBumps.push(bump);
    }

    return { wallets, walletBumps: new Uint8Array(walletBumps) };
  }

  static async createInstructions(
    program: SwitchboardProgram,
    payer: PublicKey,
    params: {
      loadAmount?: number;
      funder?: PublicKey;
      funderAuthority?: Keypair;
      queuePubkey: PublicKey;
      aggregatorPubkey: PublicKey;
      withdrawAuthority?: PublicKey;
      jobAuthorities: Array<PublicKey>;
    }
  ): Promise<[TransactionObject, LeaseAccount]> {
    const ixns: TransactionInstruction[] = [];
    const signers: Keypair[] = [];

    const loadAmount = params.loadAmount ?? 0;
    const loadTokenAmountBN = program.mint.toTokenAmountBN(loadAmount);

    const funderAuthority = params.funderAuthority
      ? params.funderAuthority.publicKey
      : payer;
    const funder = params.funder
      ? params.funder
      : program.mint.getAssociatedAddress(funderAuthority);
    const funderBalance = (await program.mint.getBalance(funderAuthority)) ?? 0;
    if (loadAmount && funderBalance < loadAmount) {
      const wrapIxns = await program.mint.wrapInstruction(
        payer,
        { amount: loadAmount },
        params.funderAuthority
      );
      ixns.push(...wrapIxns.ixns);
      signers.push(...wrapIxns.signers);
    }

    const [leaseAccount, leaseBump] = LeaseAccount.fromSeed(
      program,
      params.queuePubkey,
      params.aggregatorPubkey
    );

    const [escrow] = anchor.utils.publicKey.findProgramAddressSync(
      [
        leaseAccount.publicKey.toBuffer(),
        spl.TOKEN_PROGRAM_ID.toBuffer(),
        program.mint.address.toBuffer(),
      ],
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const { walletBumps } = LeaseAccount.getWallets(
      params.jobAuthorities,
      program.mint.address
    );

    ixns.push(
      spl.createAssociatedTokenAccountInstruction(
        payer,
        escrow,
        leaseAccount.publicKey,
        program.mint.address
      ),
      types.leaseInit(
        program,
        {
          params: {
            loadAmount: loadTokenAmountBN,
            withdrawAuthority: params.withdrawAuthority ?? payer,
            leaseBump: leaseBump,
            stateBump: program.programState.bump,
            walletBumps: walletBumps,
          },
        },
        {
          lease: leaseAccount.publicKey,
          queue: params.queuePubkey,
          aggregator: params.aggregatorPubkey,
          payer: payer,
          systemProgram: SystemProgram.programId,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          funder: funder,
          owner: funderAuthority,
          escrow: escrow,
          programState: program.programState.publicKey,
          mint: program.mint.address,
        }
      )
    );

    return [new TransactionObject(payer, ixns, signers), leaseAccount];
  }

  public static async create(
    program: SwitchboardProgram,
    params: {
      loadAmount?: number;
      mint: PublicKey;
      funder?: PublicKey;
      funderAuthority?: Keypair;
      queueAccount: QueueAccount;
      aggregatorAccount: AggregatorAccount;
      withdrawAuthority?: PublicKey;
      jobAuthorities: Array<PublicKey>;
    }
  ): Promise<[TransactionSignature, LeaseAccount]> {
    const [transaction, leaseAccount] = await LeaseAccount.createInstructions(
      program,
      program.walletPubkey,
      {
        ...params,
        aggregatorPubkey: params.aggregatorAccount.publicKey,
        queuePubkey: params.queueAccount.publicKey,
      }
    );

    const signature = await program.signAndSend(transaction);

    return [signature, leaseAccount];
  }

  public async getBalance(): Promise<number> {
    const lease = await this.loadData();
    const escrow = await spl.getAccount(this.program.connection, lease.escrow);
    return this.program.mint.fromTokenAmount(escrow.amount);
  }

  /**
   * Estimate the time remaining on a given lease
   * @params void
   * @returns number milliseconds left in lease (estimate)
   */
  public async estimatedLeaseTimeRemaining(): Promise<number> {
    // get lease data for escrow + aggregator pubkeys
    const lease = await this.loadData();
    const coder = this.program.coder;

    const accountInfos = await this.program.connection.getMultipleAccountsInfo([
      lease.aggregator,
      lease.queue,
    ]);

    // decode aggregator
    const aggregatorAccountInfo = accountInfos.shift();
    if (!aggregatorAccountInfo) {
      throw new errors.AccountNotFoundError(lease.aggregator);
    }
    const aggregator: types.AggregatorAccountData = coder.decode(
      AggregatorAccount.accountName,
      aggregatorAccountInfo.data
    );

    // decode queue
    const queueAccountInfo = accountInfos.shift();
    if (!queueAccountInfo) {
      throw new errors.AccountNotFoundError(lease.queue);
    }
    const queue: types.OracleQueueAccountData = coder.decode(
      QueueAccount.accountName,
      queueAccountInfo.data
    );

    const batchSize = aggregator.oracleRequestBatchSize + 1;
    const minUpdateDelaySeconds = aggregator.minUpdateDelaySeconds * 1.5; // account for jitters with * 1.5
    const updatesPerDay = (60 * 60 * 24) / minUpdateDelaySeconds;
    const costPerDay = batchSize * queue.reward.toNumber() * updatesPerDay;
    const oneDay = 24 * 60 * 60 * 1000; // ms in a day
    const balance = await this.getBalance();
    const endDate = new Date();
    endDate.setTime(endDate.getTime() + (balance * oneDay) / costPerDay);
    const timeLeft = endDate.getTime() - new Date().getTime();
    return timeLeft;
  }

  public async extend(params: {
    loadAmount: number;
    funder?: PublicKey;
    funderAuthority?: Keypair;
  }): Promise<TransactionSignature> {
    const leaseExtend = await this.extendInstruction(
      this.program.walletPubkey,
      params
    );
    const txnSignature = await this.program.signAndSend(leaseExtend);
    return txnSignature;
  }

  public async extendInstruction(
    payer: PublicKey,
    params: {
      loadAmount: number;
      funder?: PublicKey;
      funderAuthority?: Keypair;
    }
  ): Promise<TransactionObject> {
    const ixns: TransactionInstruction[] = [];
    const signers: Keypair[] = [];

    const lease = await this.loadData();
    const coder = this.program.coder;

    const accountInfos = await this.program.connection.getMultipleAccountsInfo([
      lease.aggregator,
      lease.queue,
    ]);

    // decode aggregator
    const aggregatorAccount = new AggregatorAccount(
      this.program,
      lease.aggregator
    );
    const aggregatorAccountInfo = accountInfos.shift();
    if (!aggregatorAccountInfo) {
      throw new errors.AccountNotFoundError(lease.aggregator);
    }
    const aggregator: types.AggregatorAccountData = coder.decode(
      AggregatorAccount.accountName,
      aggregatorAccountInfo.data
    );

    const jobs = await aggregatorAccount.loadJobs(aggregator);

    // decode queue
    const queueAccountInfo = accountInfos.shift();
    if (!queueAccountInfo) {
      throw new errors.AccountNotFoundError(lease.queue);
    }

    const jobWallets: Array<PublicKey> = [];
    const walletBumps: Array<number> = [];
    for (const idx in jobs) {
      const jobAccountData = jobs[idx].state;
      const authority = jobAccountData.authority ?? PublicKey.default;
      const [jobWallet, bump] = await PublicKey.findProgramAddress(
        [
          authority.toBuffer(),
          spl.TOKEN_PROGRAM_ID.toBuffer(),
          this.program.mint.address.toBuffer(),
        ],
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );
      jobWallets.push(jobWallet);
      walletBumps.push(bump);
    }

    const [_, leaseBump] = LeaseAccount.fromSeed(
      this.program,
      lease.queue,
      lease.aggregator
    );

    // const funder = params.funder ?? payer;
    const funderAuthority = params.funderAuthority
      ? params.funderAuthority.publicKey
      : payer;
    const funder = params.funder
      ? params.funder
      : this.program.mint.getAssociatedAddress(funderAuthority);
    const funderBalance =
      (await this.program.mint.getBalance(funderAuthority)) ?? 0;
    if (funderBalance < params.loadAmount) {
      const wrapIxns = await this.program.mint.unwrapInstruction(
        payer,
        params.loadAmount,
        params.funderAuthority
      );
      ixns.push(...wrapIxns.ixns);
      signers.push(...wrapIxns.signers);
    }

    const loadAmountLamports = this.program.mint.toTokenAmount(
      params.loadAmount
    );

    ixns.push(
      types.leaseExtend(
        this.program,
        {
          params: {
            loadAmount: new BN(loadAmountLamports.toString()),
            stateBump: this.program.programState.bump,
            leaseBump,
            walletBumps: new Uint8Array(walletBumps),
          },
        },
        {
          lease: this.publicKey,
          escrow: lease.escrow,
          aggregator: lease.aggregator,
          queue: lease.queue,
          funder: funder,
          owner: funderAuthority,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          programState: this.program.programState.publicKey,
          mint: this.program.mint.address,
        }
      )
    );

    return new TransactionObject(payer, ixns, signers);
  }

  public async withdraw(params: {
    amount: number;
    unwrap?: boolean;
    withdrawWallet?: PublicKey;
    withdrawAuthority?: Keypair;
  }): Promise<TransactionSignature> {
    const withdrawTxn = await this.withdrawInstruction(
      this.program.walletPubkey,
      params
    );
    const txnSignature = await this.program.signAndSend(withdrawTxn);
    return txnSignature;
  }

  public async withdrawInstruction(
    payer: PublicKey,
    params: {
      amount: number;
      unwrap?: boolean;
      withdrawWallet?: PublicKey;
      withdrawAuthority?: Keypair;
    }
  ): Promise<TransactionObject> {
    const txns: TransactionObject[] = [];
    const loadAmountLamports = this.program.mint.toTokenAmount(params.amount);

    const withdrawAuthority = params.withdrawAuthority
      ? params.withdrawAuthority.publicKey
      : payer;
    const withdrawWallet = params.withdrawWallet
      ? params.withdrawWallet
      : this.program.mint.getAssociatedAddress(withdrawAuthority);

    // create token wallet if it doesnt exist
    const withdrawWalletAccountInfo =
      await this.program.connection.getAccountInfo(withdrawWallet);
    if (withdrawWalletAccountInfo === null) {
      const [createUserTxn] = this.program.mint.createAssocatedUserInstruction(
        payer,
        params.withdrawAuthority
      );
      txns.push(createUserTxn);
    }

    const lease = await this.loadData();
    const accountInfos = await this.program.connection.getMultipleAccountsInfo([
      lease.aggregator,
      lease.queue,
    ]);

    // decode aggregator
    const aggregatorAccount = new AggregatorAccount(
      this.program,
      lease.aggregator
    );
    const aggregatorAccountInfo = accountInfos.shift();
    if (!aggregatorAccountInfo) {
      throw new errors.AccountNotFoundError(lease.aggregator);
    }

    // decode queue
    const queueAccountInfo = accountInfos.shift();
    if (!queueAccountInfo) {
      throw new errors.AccountNotFoundError(lease.queue);
    }

    const [_, leaseBump] = LeaseAccount.fromSeed(
      this.program,
      lease.queue,
      lease.aggregator
    );

    txns.push(
      new TransactionObject(
        payer,
        [
          types.leaseWithdraw(
            this.program,
            {
              params: {
                stateBump: this.program.programState.bump,
                leaseBump: leaseBump,
                amount: new BN(loadAmountLamports.toString()),
              },
            },
            {
              lease: this.publicKey,
              escrow: lease.escrow,
              aggregator: aggregatorAccount.publicKey,
              queue: lease.queue,
              withdrawAuthority: withdrawAuthority,
              withdrawAccount: withdrawWallet,
              tokenProgram: spl.TOKEN_PROGRAM_ID,
              programState: this.program.programState.publicKey,
              mint: this.program.mint.address,
            }
          ),
        ],
        params.withdrawAuthority ? [params.withdrawAuthority] : []
      )
    );

    if (params.unwrap) {
      txns.push(
        await this.program.mint.unwrapInstruction(
          payer,
          params.amount,
          params.withdrawAuthority
        )
      );
    }

    const packed = TransactionObject.pack(txns);
    if (packed.length > 1) {
      throw new Error(`TransactionOverflowError`);
    }

    return packed[0];
  }

  public async setAuthority(params: {
    newAuthority: PublicKey;
    withdrawAuthority: Keypair;
  }): Promise<TransactionSignature> {
    const setAuthorityTxn = this.setAuthorityInstruction(
      this.program.walletPubkey,
      params
    );
    const txnSignature = await this.program.signAndSend(setAuthorityTxn);
    return txnSignature;
  }

  public setAuthorityInstruction(
    payer: PublicKey,
    params: {
      newAuthority: PublicKey;
      withdrawAuthority?: Keypair;
    }
  ): TransactionObject {
    return new TransactionObject(
      payer,
      [
        types.leaseSetAuthority(
          this.program,
          {
            params: {},
          },
          {
            lease: this.publicKey,
            withdrawAuthority: params.withdrawAuthority
              ? params.withdrawAuthority.publicKey
              : payer,
            newAuthority: params.newAuthority,
          }
        ),
      ],
      params.withdrawAuthority ? [params.withdrawAuthority] : []
    );
  }
}
