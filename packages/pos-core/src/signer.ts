/**
 * Penandatangan event dengan kunci perangkat (ECDSA P-256, SHA-256). Tanda tangan dibuat atas string `hash`
 * event, dalam format r||s (IEEE P1363) base64url, sehingga cocok dengan verifikasi server.
 */
export interface Signer {
  /** Kunci publik SPKI DER, base64. */
  publicKey(): Promise<string>;
  /** Tanda tangan r||s base64url atas teks `message` (UTF-8). */
  sign(message: string): Promise<string>;
}

export const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toBase64Url = (b: Uint8Array): string => toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface KeyPairHolder {
  load(): Promise<CryptoKeyPair | undefined>;
  save(pair: CryptoKeyPair): Promise<void>;
}

/**
 * Kunci WebCrypto yang tidak dapat diekspor (kunci privat tetap di penyimpanan browser/WebView).
 * Pelindung perangkat lunak saja; di Android gunakan penandatangan Keystore (berbasis perangkat keras).
 */
export class WebCryptoSigner implements Signer {
  private constructor(private readonly pair: CryptoKeyPair) {}

  static async create(holder: KeyPairHolder): Promise<WebCryptoSigner> {
    let pair = await holder.load();
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      await holder.save(pair);
    }
    return new WebCryptoSigner(pair);
  }

  async publicKey(): Promise<string> {
    return toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', this.pair.publicKey)));
  }

  async sign(message: string): Promise<string> {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.pair.privateKey, new TextEncoder().encode(message));
    return toBase64Url(new Uint8Array(sig));
  }
}
