import xxhash from "xxhash-wasm";

const CCH_SEED = 0x6e52736ac806831en;
const CCH_PLACEHOLDER_PATTERN = /("text":"x-anthropic-billing-header:[^"]*?\bcch=)00000(?=;")/;
const encoder = new TextEncoder();

/** @type {Promise<(inputBuffer: Uint8Array, seed?: bigint) => bigint> | null} */
let h64RawPromise = null;

/**
 * @returns {Promise<(inputBuffer: Uint8Array, seed?: bigint) => bigint>}
 */
function getH64Raw() {
  if (!h64RawPromise) {
    h64RawPromise = xxhash().then((instance) => instance.h64Raw);
  }
  return h64RawPromise;
}

/**
 * @param {string} serializedBody
 * @returns {Promise<string>}
 */
export async function signSerializedBodyCch(serializedBody) {
  if (!CCH_PLACEHOLDER_PATTERN.test(serializedBody)) {
    return serializedBody;
  }

  const h64Raw = await getH64Raw();
  const hash = h64Raw(encoder.encode(serializedBody), CCH_SEED);
  const cch = Number(hash & 0xfffffn)
    .toString(16)
    .padStart(5, "0");

  return serializedBody.replace(CCH_PLACEHOLDER_PATTERN, `$1${cch}`);
}
