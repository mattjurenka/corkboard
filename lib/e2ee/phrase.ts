// The recovery phrase: the root as BIP39's 24 English words, shown once
// when the account is made. With every device gone, it's the only way
// back in, and nobody else has it.

import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const toPhrase = (root: Uint8Array) => {
  if (root.length !== 32) throw new Error("a root is 32 bytes");
  return entropyToMnemonic(root, wordlist);
};

// Spacing and case forgiven; a wrong word or checksum isn't.
export function fromPhrase(phrase: string): Uint8Array {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(words, wordlist)) throw new Error("that isn't a recovery phrase (a word is wrong, or missing)");
  const root = mnemonicToEntropy(words, wordlist);
  if (root.length !== 32) throw new Error("a recovery phrase is 24 words");
  return root;
}
