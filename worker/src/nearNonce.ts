/**
 * Rebuild only transactions explicitly rejected for a stale access-key nonce.
 * The mutation must disable transport retries: a lost response followed by an
 * InvalidNonce on resubmission would not prove that the first send was rejected.
 */
export async function callWithNonceRetry<T>(mutation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await mutation();
    } catch (error) {
      // @near-js/providers flattens the RPC rejection into TypedError.type.
      if (
        attempt >= 4 ||
        typeof error !== 'object' ||
        error === null ||
        !('type' in error) ||
        error.type !== 'InvalidNonce'
      )
        throw error;
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 100 * 2 ** attempt);
      await delay.promise;
    }
  }
}
