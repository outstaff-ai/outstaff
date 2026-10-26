import type { Offer, OfferQueue } from "./types.js";

export function createOfferQueue(): OfferQueue {
  const offerBuffer: Offer[] = [];
  const offerWaiters: ((r: IteratorResult<Offer>) => void)[] = [];

  return {
    push(offer) {
      // A redelivery of an offer nobody has taken yet is already in the buffer.
      if (offerBuffer.some((o) => o.workItem.id === offer.workItem.id)) {
        return;
      }

      const waiter = offerWaiters.shift();
      if (waiter) {
        waiter({ value: offer, done: false });
      } else {
        offerBuffer.push(offer);
      }
    },

    end() {
      for (const w of offerWaiters.splice(0)) {
        w({ value: undefined, done: true });
      }
    },

    iterable(done) {
      return {
        [Symbol.asyncIterator]: () => ({
          next(): Promise<IteratorResult<Offer>> {
            const offer = offerBuffer.shift();
            if (offer) {
              return Promise.resolve({ value: offer, done: false });
            }

            if (done()) {
              return Promise.resolve({ value: undefined, done: true });
            }

            return new Promise((resolve) => offerWaiters.push(resolve));
          },
        }),
      };
    },
  };
}
