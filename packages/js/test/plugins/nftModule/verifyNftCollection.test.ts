import { Nft } from '@/index';
import { Keypair } from '@solana/web3.js';
import spok, { Specifications } from 'spok';
import test, { Test } from 'tape';
import {
  assertThrows,
  createCollectionNft,
  createNft,
  killStuckProcess,
  metaplex,
  spokSamePubkey,
} from '../../helpers';
import { assertRefreshedCollectionHasSize } from './helpers';

killStuckProcess();

test('[nftModule] it can verify the collection of an NFT item', async (t: Test) => {
  // Given a Metaplex instance.
  const mx = await metaplex();

  // And an existing NFT with an unverified collection.
  const collectionAuthority = Keypair.generate();
  const collection = await createCollectionNft(mx, {
    updateAuthority: collectionAuthority,
  });
  const nft = await createNft(mx, {
    collection: collection.address,
  });
  t.true(nft.collection, 'nft has a collection');
  t.false(nft.collection?.verified, 'nft collection is not verified');
  await assertRefreshedCollectionHasSize(t, mx, collection, 0);

  // When we verify the collection.
  await mx
    .nfts()
    .verifyCollection(nft, {
      collectionAuthority,
    })
    .run();

  // Then the NFT collection should be verified.
  const updatedNft = await mx.nfts().refresh(nft).run();
  spok(t, updatedNft, {
    $topic: 'Updated Nft',
    model: 'nft',
    collection: {
      address: spokSamePubkey(collection.address),
      verified: true,
    },
  } as unknown as Specifications<Nft>);

  // And the collection should have the updated size.
  await assertRefreshedCollectionHasSize(t, mx, collection, 1);
});

test('[nftModule] it can verify the legacy collection of an NFT item', async (t: Test) => {
  // Given a Metaplex instance.
  const mx = await metaplex();

  // And an existing NFT with an unverified legacy collection.
  const collectionAuthority = Keypair.generate();
  const collection = await createNft(mx, {
    updateAuthority: collectionAuthority,
  });
  const nft = await createNft(mx, {
    collection: collection.address,
  });
  t.true(nft.collection, 'nft has a collection');
  t.false(nft.collection?.verified, 'nft collection is not verified');
  t.false(collection.collectionDetails, 'collection is legacy');

  // When we verify the collection.
  await mx
    .nfts()
    .verifyCollection(nft, {
      collectionAuthority,
      isSizedCollection: false,
    })
    .run();

  // Then the NFT collection should be verified.
  const updatedNft = await mx.nfts().refresh(nft).run();
  spok(t, updatedNft, {
    $topic: 'Updated Nft',
    model: 'nft',
    collection: {
      address: spokSamePubkey(collection.address),
      verified: true,
    },
  } as unknown as Specifications<Nft>);
});

test('[nftModule] it cannot verify the collection of an NFT item that has no parent collection', async (t: Test) => {
  // Given a Metaplex instance.
  const mx = await metaplex();

  // And an existing NFT with no collection.
  const nft = await createNft(mx);
  t.false(nft.collection, 'nft has no collection');

  // When we try to verify the collection.
  const promise = mx.nfts().verifyCollection(nft).run();

  // Then we should get an error.
  await assertThrows(t, promise, /Parent Collection Missing/);
});
