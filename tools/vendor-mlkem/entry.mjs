/* The one thing the page needs from @noble/post-quantum: ML-KEM-768, the
   parameter set FIPS 203 calls category 3 and the one Signal and the relay
   links here already use. Nothing else from the package is bundled.

   Published as a plain object on the global, like every other script the
   page loads: three functions over Uint8Array, and the sizes they deal in. */
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

globalThis.PoorijaMlKem = Object.freeze({
  name: 'ML-KEM-768',
  publicKeyBytes: 1184,
  secretKeyBytes: 2400,
  ciphertextBytes: 1088,
  sharedSecretBytes: 32,
  /* { publicKey, secretKey }. `seed` (64 bytes) makes it deterministic, which
     is what the known-answer tests need and nothing else should use. */
  keygen: (seed) => ml_kem768.keygen(seed),
  /* { cipherText, sharedSecret }. `message` (32 bytes) likewise. */
  encapsulate: (publicKey, message) => ml_kem768.encapsulate(publicKey, message),
  /* sharedSecret. A ciphertext that was not made for this key gives a secret
     that matches nothing, by design (implicit rejection), rather than an error. */
  decapsulate: (cipherText, secretKey) => ml_kem768.decapsulate(cipherText, secretKey),
});
