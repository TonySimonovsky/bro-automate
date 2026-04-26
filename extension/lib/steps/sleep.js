// steps/sleep.js — explicit wait in ms. Cancel-aware (races against ctx.cancelToken).
// Errors: cancelled, internal.
// TDD: §7.3, §7.6
// Tasks: T-511
// Wave: 3
// Status: implemented (Wave 3)

/**
 * @param {object} ctx
 * @param {{ type: 'sleep', ms: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  const ms = step.ms;
  if (ms <= 0) {
    return { slept: ms };
  }
  return await new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      resolve({ slept: step.ms });
    }, ms);
    ctx.cancelToken
      .then(() => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(t);
        reject({ code: 'cancelled', message: 'cancelled during sleep' });
      })
      .catch(() => {
        /* never for contract cancelToken */
      });
  });
}
