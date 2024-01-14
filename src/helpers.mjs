export const genRanHex = (/** @type {number} */ size) => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

/**
 * @param {number} ms
 */
export async function sleep(ms)
{
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @typedef {Object} RetryContext An object describing the retry context
 * @property {number} currentTry The current retry attempt number
 * @property {Error} error The error that occurred during the last attempt
 * @property {number} maxRetries The maximum number of retries allowed
 */
/**
 * Retry the function until it succeeds or the maximum number of retries is reached
 * @template T
 * @param {() => Promise<T>} func The function to retry
 * @param {number} maxRetries The maximum number of retries to attempt
 * @param {(retryContext: RetryContext) => Promise} [onRetry] Called each time the function needs to be retried, with the current try number and the maximum number of retries as parameters
 * @param {(retryContext: RetryContext) => Promise} [onFail] Called when the maximum number of retries is reached and the function has not yet succeeded
 * @returns {Promise<T>} A promise that resolves to the result of the function if it succeeded within the maximum number of retries, or rejects with an error otherwise
 */
export async function retryWrapper(func, maxRetries, onRetry, onFail)
{
    const retryContext = { currentTry: 1, error: undefined, maxRetries }

    while (retryContext.currentTry <= retryContext.maxRetries)
    {
        try
        {
            return await func();
        } catch (error)
        {
            retryContext.error = error;
            if (onRetry)
            {
                await onRetry(retryContext);
            }
        }
        retryContext.currentTry++;
    }

    if (onFail)
    {
        await onFail(retryContext);
    }

    // throw new Error(`retryWrapper: function failed after ${maxRetries} retries`);
}

export function wrapQuotes(text)
{
    return `"${text.replaceAll("\"", "\\\"")}"`
}

/**
 * @param {number} num
 * @param {number} precision
 */
export function roundWithPrecision(num, precision)
{
    var multiplier = Math.pow(10, precision);
    return Math.round(num * multiplier) / multiplier;
}
