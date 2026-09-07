export interface Stored {
  body: ReadableStream<Uint8Array>;
  size: number;
}
export interface Storage {
  put(key: string, body: ReadableStream<Uint8Array>): Promise<void>;
  get(key: string): Promise<Stored | null>;
  delete(key: string): Promise<void>;
}
export class R2Storage implements Storage {
  constructor(private bucket: R2Bucket) {}
  async put(key: string, body: ReadableStream<Uint8Array>) {
    await this.bucket.put(key, body);
  }
  async get(key: string) {
    const o = await this.bucket.get(key);
    return o ? { body: o.body, size: o.size } : null;
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}
