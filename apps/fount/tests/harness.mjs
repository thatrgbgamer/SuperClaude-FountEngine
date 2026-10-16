// A very small test runner: no dependencies, same spirit as the engine.
// Each test file calls test(name, fn) and finish() at the end. Tests may be
// async; finish() waits for all of them, so a rejected promise is a failure
// rather than a silent pass.

let passed = 0;
let failed = 0;
const pending = [];
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function report(name, err, note) {
  if (err) {
    failed++;
    const detail = err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : String(err);
    console.log(`${red('FAIL')}  ${name}\n      ${detail}`);
  } else {
    passed++;
    console.log(`${green('PASS')}  ${name}${note ? '  — ' + note : ''}`);
  }
}

// Tests run one after another, in the order they are written, so an async test
// that opens sockets or changes a shared server never races the next one.
let chain = Promise.resolve();

export function test(name, fn) {
  chain = chain.then(async () => {
    try {
      const note = await fn();
      report(name, null, typeof note === 'string' ? note : '');
    } catch (err) {
      report(name, err);
    }
  });
  pending.push(chain);
}

export function assert(cond, message = 'assertion failed') {
  if (!cond) throw new Error(message);
}

export function near(a, b, eps = 1e-3, message = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${message} expected ${b}, got ${a}`);
}

export function throws(fn, pattern) {
  try { fn(); } catch (err) {
    if (pattern && !pattern.test(err.message)) throw new Error(`threw the wrong error: ${err.message}`);
    return;
  }
  throw new Error('expected an error, none was thrown');
}

export async function finish() {
  await Promise.all(pending);
  console.log(`\n${failed ? red(`${failed} failed`) : green('all passed')}: ${passed} of ${passed + failed}`);
  if (failed) process.exitCode = 1;
}
