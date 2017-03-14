
export class DeadlineError extends Error {
  constructor() {
    super(`Context deadline exceeded`);
  }
}
const deadlineError = new DeadlineError();

export class CancelledError extends Error {
  constructor() {
    super(`Context cancelled`);
  }
}
const cancelledError = new CancelledError();

// A key for a contextual value added to an IContext. This must be usable as a
// key for an object property.
export type Key = string | Symbol;

// IContext is an arbitrary object which constitutes a context for the purposes
// of scheduling asynchronous operations which may peform I/O. It is directly
// inspired by Go's context.Context interface and serves the following functions:
//
//   - It ensures that the desired cancellation or timeout of any asynchronous
//     operation can be indicated in a generic fashion. All asynchronous operations
//     SHOULD accept an IContext and SHOULD use said IContext to implement cancellation
//     and timeouts as appropriate.
//
//   - It provides an escape hatch for the communication of variables
//     contextually. Because an asynchronous operation is not bound to the
//     lifetime of a calling function's stack frame, the use of global/'thread
//     local' variables is unsuitable for the purposes of communicating
//     contextual variables to an asynchronous operation and any suboperations
//     deriving therefrom for the whole lifetime of the asynchronous operation.
//     Such contextual variables must be passed explicitly as arguments, or as
//     values accessible from another object passed as an argument. IContext
//     serves this role, by allowing arbitrary contextual objects to be
//     obtained from it, where they have been previously set.
//
//   - Similarly to Go's context.Context, IContext uses a functional composition
//     style wherein the behaviour of an IContext is modified by wrapping
//     another IContext, rather than allowing an IContext to be mutated. This
//     works very well with the progression of the call stack, as subsidiary
//     operations can have additional contextual objects passed in their object
//     without mutating the existing context, can have additional timeouts
//     assigned, etc.
//
export interface IContext {
  // Returns the point in time at which operations under this context should be
  // cancelled. Returns null if no deadline is set. Successive calls to
  // deadline on a given IContext return the same value.
  //
  // I/O operations should throw error() (or reject their promise with error())
  // if they discover that this deadline has passed. It is acceptable for
  // higher-level functions which compose more fundamental I/O operations to
  // rely on those operations to do this and neglect to check deadline()
  // themselves.
  deadline: Date | null;

  // Registers a done handler. This is a nil-arity function which is called
  // when error() ceases to return null for the first time; that is, when the
  // context is cancelled or a deadline is passed. A registered handler is
  // never called more than once and calling doneHandler when error() is
  // already returning non-null will result in an immediate call to the
  // function.
  //
  // A done handler can be cancelled by calling the returned nil-arity
  // function. Calling this after the done handler has been called is a no-op,
  // and calling the returned function more than once is also inconsequential.
  doneHandler(f: () => void): (() => void);

  // Returns an Error if the context has been cancelled or a deadline has been
  // exceeded. Otherwise, returns null.
  error: Error | null;

  // Obtains the contextual value identified by key. Returns undefined if it is
  // not set.
  value(key: Key): any;
}


/* Utility Functions
 * -----------------
 */

// Registers a doneHandler on the provided context for the duration of the
// asynchronous call to scopeFunc. Returns the value returned by scopeFunc. The
// doneHandler is always unregistered when this asynchronous function returns
// or when an error is thrown.
export async function withDoneHandler(ctx: IContext, handler: () => void, scopeFunc: () => Promise<any>): Promise<any> {
  const unreg = ctx.doneHandler(handler);

  let rv: any;
  try {
    rv = await scopeFunc();
  } finally {
    unreg();
  }

  return rv;
}


/* Empty Context
 * -------------
 */
const _noop = () => {};
class _EmptyContext implements IContext {
  get deadline(): Date | null { return null; }
  doneHandler(f: () => void): (() => void) { return _noop; }
  get error(): Error | null { return null; }
  value(key: Key): any { return undefined; }

  toString(): string {
    if (this === _background)
      return 'context.background';
    if (this === _todo)
      return 'context.todo';
    return 'unknown empty context';
  }
}

const _background = new _EmptyContext();
const _todo = new _EmptyContext();

export function background(): IContext {
  return _background;
}

export function todo(): IContext {
  return _todo;
}


/* Value Context
 * -------------
 */
export function withValue(parentCtx: IContext, key: Key, value: any): IContext {
  return new _ValueContext(parentCtx, key, value);
}

class _ValueContext implements IContext {
  private __parentCtx: IContext;
  private __key: Key;
  private __value: any;

  constructor(parentCtx: IContext, key: Key, value: any) {
    this.__parentCtx = parentCtx;
    this.__key = key;
    this.__value = value;
  }

  get deadline(): Date | null { return this.__parentCtx.deadline; }

  doneHandler(f: (() => void)): (() => void) { return this.__parentCtx.doneHandler(f); }

  get error(): Error | null { return this.__parentCtx.error; }

  value(key: Key): any {
    if (this.__key === key)
      return this.__value;
    return this.__parentCtx.value(key);
  }
}


/* Cancel/Deadline Context
 * -----------------------
 */
const symCancelFunc = Symbol();

class _CancelContext implements IContext {
  private __parentCtx: IContext;
  private __deadline: Date | null;
  private __error: Error | null = null;
  private __doneHandlers: [Symbol, () => void][] = [];
  private __unregParentFunc: (() => void) | null;

  constructor(parentCtx: IContext, deadline: Date | null=null) {
    this.__parentCtx = parentCtx;
    this.__deadline = deadline;
    this.__unregParentFunc = parentCtx.doneHandler(() => {
      this.__unregParentFunc = null;
      (this as any)[symCancelFunc](parentCtx.error);
    });

    if (deadline !== null && this.__error === null) {
      const f = () => { (this as any)[symCancelFunc](deadlineError); };
      const tr = +deadline - +new Date();
      if (tr <= 0)
        f();
      else
        setTimeout(f, tr);
    }
  }

  get deadline(): Date | null { return (this.__deadline !== null) ? this.__deadline : this.__parentCtx.deadline; }
  get error(): Error | null { return this.__error; }
  value(key: Key): any { return this.__parentCtx.value(key); }

  doneHandler(f: () => void): (() => void) {
    if (this.__error !== null) {
      f();
      return _noop;
    }

    const s = Symbol();
    this.__doneHandlers.push([s, f]);
    return () => {
      this.__doneHandlers = this.__doneHandlers.filter(x => x[0] !== s);
    };
  }

  toString(): string {
    return this.__parentCtx.toString() + ((this.__deadline !== null) ? '.withDeadline' : '.withCancel');
  }

  [symCancelFunc](err: Error) {
    if (!err)
      throw new Error("must have an error when cancelling");

    if (this.error !== null)
      return; // Already cancelled.

    this.__error = err;
    for (const h of this.__doneHandlers)
      h[1]();
    this.__doneHandlers = [];
    if (this.__unregParentFunc) {
      this.__unregParentFunc();
      this.__unregParentFunc = null;
    }
  }
}


/* Deadline Context
 * ----------------
 */
export function withDeadline(parentCtx: IContext, deadline: Date | null): [IContext, () => void] {
  const ctx = new _CancelContext(parentCtx, deadline);
  return [ctx, () => { (ctx as any)[symCancelFunc](true, cancelledError); }];
}

export function withTimeout(parentCtx: IContext, timeout: number /* ms */): [IContext, () => void] {
  let d = new Date();
  d = new Date(+d + timeout);
  return withDeadline(parentCtx, d);
}

/* Cancel Context
 * --------------
 */
export function withCancel(parentCtx: IContext): [IContext, () => void] {
  return withDeadline(parentCtx, null);
}

/* Promise Utilities
 * -----------------
 */

// Returns a promise that will be rejected with ctx.error when ctx expires. The
// promise is never resolved and may never be rejected.
export function expiryPromise(ctx: IContext): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ctx.doneHandler(() => {
      reject(ctx.error);
    });
  });
}

// Can be used to abort functions which don't support contexts or other means
// of cancellation. The function f initiates the process and returns a promise;
// but if ctx expires before the promise is resolved, the promise returned by
// this function is rejected and any future resolution of that promise is
// ignored. If ctx is already expired, an already-rejected promise is returned
// and f is not called.
//
// If cleanupFunc is non-null, it is called with the resolved value of the
// promise returned by f iff it resolves after the context expires (and thus
// never becomes the resolved value of the promise returned by this function).
// This function can be used to cleanup non-memory resources created by the
// process initiated by a call to f, in the event that they complete after the
// context expires.
export function raceContext<T>(ctx: IContext, f: () => Promise<T>, cleanupFunc: ((x: T) => void) | null=null): Promise<T> {
  if (ctx.error !== null)
    return Promise.reject(ctx.error);

  let aborted = false;

  return new Promise<T>((resolve, reject) => {
    f()
      .then(x => {
        if (aborted && cleanupFunc)
          cleanupFunc(x);

        resolve(x);
      }, reject);

    expiryPromise(ctx)
      .catch(e => {
        aborted = true;
        reject(e);
      });
  });

  //return Promise.race([expiryPromise(ctx), p]);
}
