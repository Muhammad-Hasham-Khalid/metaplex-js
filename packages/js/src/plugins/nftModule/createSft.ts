import { Metaplex } from '@/Metaplex';
import {
  BigNumber,
  Creator,
  CreatorInput,
  isSigner,
  Operation,
  OperationHandler,
  Signer,
  SplTokenAmount,
  toPublicKey,
  useOperation,
} from '@/types';
import { DisposableScope, Option, Task, TransactionBuilder } from '@/utils';
import {
  createCreateMetadataAccountV3Instruction,
  Uses,
} from '@metaplex-foundation/mpl-token-metadata';
import { ConfirmOptions, Keypair, PublicKey } from '@solana/web3.js';
import { SendAndConfirmTransactionResponse } from '../rpcModule';
import { findAssociatedTokenAccountPda } from '../tokenModule';
import type { NftBuildersClient } from './NftBuildersClient';
import type { NftClient } from './NftClient';
import { findMetadataPda } from './pdas';
import { assertSft, Sft, SftWithToken } from './Sft';

// -----------------
// Clients
// -----------------

/** @internal */
export function _createSftClient(
  this: NftClient,
  input: CreateSftInput
): Task<CreateSftOutput & { sft: Sft | SftWithToken }> {
  return new Task(async (scope) => {
    const operation = createSftOperation(input);
    const output = await this.metaplex.operations().execute(operation, scope);
    scope.throwIfCanceled();
    const sft = await this.findByMint(output.mintAddress, {
      tokenAddress: output.tokenAddress ?? undefined,
    }).run(scope);
    assertSft(sft);
    return { ...output, sft };
  });
}

/** @internal */
export function _createSftBuildersClient(
  this: NftBuildersClient,
  input: CreateSftBuilderParams
) {
  return createSftBuilder(this.metaplex, input);
}

// -----------------
// Operation
// -----------------

const Key = 'CreateSftOperation' as const;
export const createSftOperation = useOperation<CreateSftOperation>(Key);
export type CreateSftOperation = Operation<
  typeof Key,
  CreateSftInput,
  CreateSftOutput
>;

export interface CreateSftInput {
  // Accounts.
  payer?: Signer; // Defaults to mx.identity().
  updateAuthority?: Signer; // Defaults to mx.identity().
  mintAuthority?: Signer; // Defaults to mx.identity().
  freezeAuthority?: Option<PublicKey>; // Defaults to mx.identity().

  // Mint Account.
  useNewMint?: Signer; // Defaults to new generated Keypair.
  useExistingMint?: PublicKey;

  // Optional Token Account. Defaults to no token account.
  tokenAddress?: PublicKey | Signer;
  tokenOwner?: PublicKey;
  tokenAmount?: SplTokenAmount;

  // Data.
  decimals?: number; // Defaults to 0.
  uri: string;
  name: string;
  sellerFeeBasisPoints: number;
  symbol?: string; // Defaults to an empty string.
  creators?: CreatorInput[]; // Defaults to mx.identity() as a single Creator.
  isMutable?: boolean; // Defaults to true.
  maxSupply?: Option<BigNumber>; // Defaults to 0.
  uses?: Option<Uses>; // Defaults to null.
  isCollection?: boolean; // Defaults to false.
  collection?: Option<PublicKey>; // Defaults to null.
  collectionAuthority?: Option<Signer>; // Defaults to null.
  collectionAuthorityIsDelegated?: boolean; // Defaults to false.
  collectionIsSized?: boolean; // Defaults to true.

  // Programs.
  tokenProgram?: PublicKey;
  associatedTokenProgram?: PublicKey;

  // Options.
  confirmOptions?: ConfirmOptions;
}

export interface CreateSftOutput {
  response: SendAndConfirmTransactionResponse;
  mintAddress: PublicKey;
  metadataAddress: PublicKey;
  tokenAddress: PublicKey | null;
}

// -----------------
// Handler
// -----------------

export const createSftOperationHandler: OperationHandler<CreateSftOperation> = {
  handle: async (
    operation: CreateSftOperation,
    metaplex: Metaplex,
    scope: DisposableScope
  ) => {
    const builder = await createSftBuilder(metaplex, operation.input);
    scope.throwIfCanceled();
    return builder.sendAndConfirm(metaplex, operation.input.confirmOptions);
  },
};

// -----------------
// Builder
// -----------------

export type CreateSftBuilderParams = Omit<CreateSftInput, 'confirmOptions'> & {
  createMintAccountInstructionKey?: string;
  initializeMintInstructionKey?: string;
  createAssociatedTokenAccountInstructionKey?: string;
  createTokenAccountInstructionKey?: string;
  initializeTokenInstructionKey?: string;
  mintTokensInstructionKey?: string;
  createMetadataInstructionKey?: string;
};

export type CreateSftBuilderContext = Omit<CreateSftOutput, 'response'>;

export const createSftBuilder = async (
  metaplex: Metaplex,
  params: CreateSftBuilderParams
): Promise<TransactionBuilder<CreateSftBuilderContext>> => {
  const {
    payer = metaplex.identity(),
    useNewMint = Keypair.generate(),
    updateAuthority = metaplex.identity(),
    mintAuthority = metaplex.identity(),
  } = params;

  const mintAndTokenBuilder = await createMintAndTokenForSftBuilder(
    metaplex,
    params,
    useNewMint
  );
  const { mintAddress, tokenAddress } = mintAndTokenBuilder.getContext();

  const metadataPda = findMetadataPda(mintAddress);
  const creatorsInput: CreatorInput[] = params.creators ?? [
    {
      address: updateAuthority.publicKey,
      authority: updateAuthority,
      share: 100,
    },
  ];
  const creators: Option<Creator[]> =
    creatorsInput.length > 0
      ? creatorsInput.map((creator) => ({
          ...creator,
          verified: creator.address.equals(updateAuthority.publicKey),
        }))
      : null;

  const createMetadataInstruction = createCreateMetadataAccountV3Instruction(
    {
      metadata: metadataPda,
      mint: mintAddress,
      mintAuthority: mintAuthority.publicKey,
      payer: payer.publicKey,
      updateAuthority: updateAuthority.publicKey,
    },
    {
      createMetadataAccountArgsV3: {
        data: {
          name: params.name,
          symbol: params.symbol ?? '',
          uri: params.uri,
          sellerFeeBasisPoints: params.sellerFeeBasisPoints,
          creators,
          collection: params.collection
            ? { key: params.collection, verified: false }
            : null,
          uses: params.uses ?? null,
        },
        isMutable: params.isMutable ?? true,
        collectionDetails: params.isCollection
          ? { __kind: 'V1', size: 0 } // Program will hardcode size to zero anyway.
          : null,
      },
    }
  );

  // When the payer is different than the update authority, the latter will
  // not be marked as a signer and therefore signing as a creator will fail.
  createMetadataInstruction.keys[4].isSigner = true;

  const verifyAdditionalCreatorInstructions = creatorsInput
    .filter((creator) => {
      return (
        !!creator.authority &&
        !creator.address.equals(updateAuthority.publicKey)
      );
    })
    .map((creator) => {
      return metaplex.nfts().builders().verifyCreator({
        mintAddress,
        creator: creator.authority,
      });
    });

  return (
    TransactionBuilder.make<CreateSftBuilderContext>()
      .setFeePayer(payer)
      .setContext({
        mintAddress,
        metadataAddress: metadataPda,
        tokenAddress,
      })

      // Create the mint and token accounts before minting 1 token to the owner.
      .add(mintAndTokenBuilder)

      // Create metadata account.
      .add({
        instruction: createMetadataInstruction,
        signers: [payer, mintAuthority, updateAuthority],
        key: params.createMetadataInstructionKey ?? 'createMetadata',
      })

      // Verify additional creators.
      .add(...verifyAdditionalCreatorInstructions)

      // Verify collection.
      .when(!!params.collection && !!params.collectionAuthority, (builder) =>
        builder.add(
          metaplex
            .nfts()
            .builders()
            .verifyCollection({
              payer,
              mintAddress,
              collectionMintAddress: params.collection as PublicKey,
              collectionAuthority: params.collectionAuthority as Signer,
              isDelegated: params.collectionAuthorityIsDelegated ?? false,
              isSizedCollection: params.collectionIsSized ?? true,
            })
        )
      )
  );
};

const createMintAndTokenForSftBuilder = async (
  metaplex: Metaplex,
  params: CreateSftBuilderParams,
  useNewMint: Signer
): Promise<
  TransactionBuilder<{ mintAddress: PublicKey; tokenAddress: PublicKey | null }>
> => {
  const {
    payer = metaplex.identity(),
    mintAuthority = metaplex.identity(),
    freezeAuthority = metaplex.identity().publicKey,
  } = params;

  const mintAddress = params.useExistingMint ?? useNewMint.publicKey;
  const associatedTokenAddress = params.tokenOwner
    ? findAssociatedTokenAccountPda(mintAddress, params.tokenOwner)
    : null;
  const tokenAddress = params.tokenAddress
    ? toPublicKey(params.tokenAddress)
    : associatedTokenAddress;

  let tokenExists: boolean;
  if (!!params.useExistingMint && !!tokenAddress) {
    const tokenAccount = await metaplex.rpc().getAccount(tokenAddress);
    tokenExists = tokenAccount.exists;
  } else {
    tokenExists = false;
  }

  const builder = TransactionBuilder.make<{
    mintAddress: PublicKey;
    tokenAddress: PublicKey | null;
  }>().setContext({
    mintAddress,
    tokenAddress,
  });

  // Create the mint account if it doesn't exist.
  if (!params.useExistingMint) {
    builder.add(
      await metaplex
        .tokens()
        .builders()
        .createMint({
          decimals: params.decimals ?? 0,
          mint: useNewMint,
          payer,
          mintAuthority: mintAuthority.publicKey,
          freezeAuthority,
          tokenProgram: params.tokenProgram,
          createAccountInstructionKey: params.createMintAccountInstructionKey,
          initializeMintInstructionKey: params.initializeMintInstructionKey,
        })
    );
  }

  // Create the token account if it doesn't exist.
  const isNewToken = !!params.tokenAddress && isSigner(params.tokenAddress);
  const isNewAssociatedToken = !!params.tokenOwner;
  if (!tokenExists && (isNewToken || isNewAssociatedToken)) {
    builder.add(
      await metaplex
        .tokens()
        .builders()
        .createToken({
          mint: mintAddress,
          owner: params.tokenOwner,
          token: params.tokenAddress as Signer | undefined,
          payer,
          tokenProgram: params.tokenProgram,
          associatedTokenProgram: params.associatedTokenProgram,
          createAssociatedTokenAccountInstructionKey:
            params.createAssociatedTokenAccountInstructionKey,
          createAccountInstructionKey: params.createTokenAccountInstructionKey,
          initializeTokenInstructionKey: params.initializeTokenInstructionKey,
        })
    );
  }

  // Mint provided amount to the token account.
  if (tokenAddress && params.tokenAmount) {
    builder.add(
      await metaplex.tokens().builders().mint({
        mint: mintAddress,
        toToken: tokenAddress,
        toTokenExists: true,
        amount: params.tokenAmount,
        mintAuthority,
        tokenProgram: params.tokenProgram,
        mintTokensInstructionKey: params.mintTokensInstructionKey,
      })
    );
  }

  return builder;
};
