# Effect Idioms & APIs for didact

**Core principle**: Effect has built-in APIs for common patterns. Use them instead of manual implementations.

## Data Types - Use instead of null/undefined!

**Option** - Represents optional values: `Some(value)` or `None`

- `Option.some(value)` / `Option.none()` - constructors
- `Option.isSome/isNone` - guards
- `Option.match(opt, { onNone, onSome })` - pattern matching
- `Option.map/flatMap/filter` - transformations
- `Option.getOrElse(opt, () => default)` - extract with fallback
- `Option.fromNullable(value)` - convert from null/undefined
- Use in generator: `const value = yield* option` (short-circuits on None)

**Either** - Represents success (Right) or failure (Left)

- `Either.right(value)` / `Either.left(error)` - constructors
- `Either.isLeft/isRight` - guards
- `Either.match(either, { onLeft, onRight })` - pattern matching
- `Either.map/mapLeft/mapBoth` - transformations
- `Either.getOrElse(either, () => default)` - extract with fallback
- Works as subtype of Effect: `Left<E>` → `Effect<never, E>`, `Right<A>` → `Effect<A>`
- Use in generator: `const value = yield* either` (short-circuits on Left)

## State & Services

**Atom** (@effect-atom/atom) - `Atom.make/get/set/update` - reactive state with auto-subscriptions (NOT Ref!)
**Ref** - ONLY for internal non-reactive runtime state (e.g. DOM nodes, cache)

- `Ref.make(initial)` - create mutable reference
- `Ref.get/set/update/modify` - operations (all return Effect)
  **Effect.Service** - Define services with `class X extends Effect.Service<X>()("X", { scoped: ... })`
- Use `scoped` option for lifecycle management
- Use `accessors: true` for convenience methods
- Services accessed via `yield* ServiceName` in generators
  **Effect.provide(layer)** - Provide service implementation to effect
  **Effect.provideService(tag, impl)** - Provide single service inline

## Collections & Data

**HashMap** - Immutable map: `HashMap.empty/make/get/set/has/remove/keys/values/entries`

- Use for props, component IDs, caching (NOT `Map` or `{}`)
- Returns `Option` for `get` operations
  **Chunk** - Immutable array: returned by `Queue.takeAll`, `Stream` operations
- `Chunk.toReadonlyArray` if you need array operations
- More efficient than arrays for Effect operations

## Control Flow

**Effect.if(predicate, { onTrue, onFalse })** - Conditional with effectful predicate
**Effect.when(condition)** - Execute effect only if condition true (returns `Option`)
**Effect.whenEffect(predicateEffect)** - Like `when` but condition is an Effect
**Effect.unless/unlessEffect** - Opposite of when (execute if condition false)

## Async Coordination

**Queue** - Type-safe async queue (NOT custom promise/callback systems)

- `Queue.bounded(n)` - backpressure when full
- `Queue.unbounded()` - no limit (use for render work queue)
- `Queue.offer/take/takeAll/poll/offerAll/takeUpTo/takeN` - operations
- NEVER manually poll in a loop - use `Queue.takeAll`
  **Stream** - Pull-based reactive streams (NOT RxJS, NOT manual event emitters)
- `Stream.runForEach(stream, fn)` - consume stream
- `Stream.fromQueue` - convert queue to stream
- `Stream.map/filter/flatMap` - transformations
- Supports backpressure, error handling, resource safety

## Concurrency & Fibers

**Effect.fork** - Run in new fiber (returns `RuntimeFiber`)
**Effect.forkIn(effect, scope)** - Fork in scope (auto-cleanup)
**Effect.forkDaemon** - Fork detached fiber (not interrupted by parent)
**Fiber.join(fiber)** - Wait for fiber completion
**Fiber.interrupt(fiber)** - Cancel fiber
**Fiber.await(fiber)** - Wait and get `Exit` result
**FiberSet** - Manage fiber collections (NOT `Promise.all`)

- `FiberSet.makeRuntime` - create runtime backed by FiberSet
- All fibers cleaned up when scope closes

## Interruption Control

**Effect.interrupt** - Immediately interrupt current fiber
**Effect.interruptible(effect)** - Mark region as interruptible
**Effect.uninterruptible(effect)** - Mark region as uninterruptible
**Effect.onInterrupt(cleanup)** - Run cleanup on interruption

## Resource Management

**Effect.addFinalizer(cleanup)** - Register cleanup (runs on scope close)
**Effect.scoped(effect)** - Wrap effect with new scope
**Effect.acquireRelease(acquire, release)** - Safe resource pattern
**Effect.acquireUseRelease(acquire, use, release)** - Full resource lifecycle
**Effect.ensuring(finalizer)** - Run finalizer after effect (like finally)
**Scope.fork(scope)** - Create child scope

- Finalizers run in REVERSE order (stack unwinding)
- Guaranteed to run on success, failure, or interruption

## Iteration - NEVER use manual for/while with effects!

**Effect.forEach(items, fn, opts)** - Replace `for` loops

- `{ concurrency: "unbounded" | number }` - parallel execution
- `{ discard: true }` - don't collect results (memory efficient)
  **Effect.all(effects, opts)** - Run multiple effects (arrays/tuples/structs/records)
- `{ concurrency: "unbounded" | number }` - control parallelism
- `{ mode: "default" | "either" | "validate" }` - error handling mode
- Preserves structure of input (tuple → tuple, struct → struct)
  **Effect.iterate(initial, { while, body })** - Replace while loops
  **Effect.loop(initial, { while, step, body })** - For loops with accumulation
  **Effect.reduce(items, init, fn)** - Sequential fold
  **Effect.filter(items, predicate)** - Filter with effectful predicate
  **Effect.partition(items, fn)** - Split into [failures, successes]
  **Effect.every(items, predicate)** - Check if all match
  **Effect.exists(items, predicate)** - Check if any match
  **Effect.findFirst(items, predicate)** - Find first match (returns `Option`)
  **Queue.takeAll(queue)** - Atomic drain, returns Chunk (NOT while + poll loop)

## Defects & Exits

**Effect.die(error)** - Throw unrecoverable error (defect)
**Effect.dieMessage(message)** - Die with string message
**Effect.exit** - Get `Exit<A, E>` result (includes cause info)

## Pattern Matching & Inspection

**Effect.match({ onFailure, onSuccess })** - Pattern match on result
**Effect.matchEffect({ onFailure, onSuccess })** - Pattern match with effects
**Effect.matchCause/matchCauseEffect** - Match on full cause (includes defects)

## Validation & Error Accumulation

**Effect.validate(effect, opts)** - Run effect, accumulate errors (NOT fail-fast)
**Effect.validateAll(effects)** - Validate all, collect all failures
**Effect.validateFirst(effects)** - Return first success or all failures

## Caching & Memoization

**Effect.cached** - Cache result, re-execute on invalidation
**Effect.cachedWithTTL(duration)** - Cache with time-to-live
**Effect.cachedInvalidateWithTTL(duration)** - TTL cache with manual invalidation
**Effect.once** - Ensure effect runs only once, cache forever
**Effect.cachedFunction(fn)** - Memoize effectful function

## Observability

**Effect.log(message)** - Structured logging (NOT `console.log`)
**Effect.logDebug/logInfo/logWarning/logError/logFatal** - Log at specific level
**Effect.withSpan(name)** - Create tracing span for observability
**Effect.annotateCurrentSpan(key, value)** - Add metadata to current span

## Effect Constructors

**Effect.succeed(value)** - Create successful effect
**Effect.fail(error)** - Create failed effect
**Effect.sync(() => value)** - Wrap synchronous code
**Effect.promise(() => promise)** - Wrap promise (cannot fail)
**Effect.tryPromise(() => promise)** - Wrap promise (can fail)
**Effect.async(register)** - Create from callback
**Effect.gen(function\*)** - Generator-based do-notation

## Pipeable Transformations

**Effect.map(fn)** - Transform success value
**Effect.flatMap(fn)** - Chain effects
**Effect.andThen(nextEffect)** - Sequence effects
**Effect.tap(fn)** - Side-effect without changing value
**Effect.as(value)** - Replace result with constant
**Effect.void** - Discard result → `Effect<void>`
**Effect.ignore** - Discard success AND failure → `Effect<void, never>`

## Error Channel Operations

**Effect.mapError(fn)** - Transform error type
**Effect.mapBoth({ onFailure, onSuccess })** - Transform both channels
**Effect.flip** - Swap error and success channels
**Effect.catchAll(handler)** - Recover from all errors
**Effect.catchTag(tag, handler)** - Catch specific tagged error
**Effect.either** - Move error to success as `Either<A, E>`
**Effect.option** - Convert errors to `None`
**Effect.orElse(() => fallback)** - Try fallback on error
**Effect.orElseSucceed(value)** - Provide fallback value
**Effect.orDie** - Convert error to defect (unrecoverable)
**Effect.firstSuccessOf(effects)** - Return first success

## Filtering & Predicates

**Effect.filter(predicate)** - Filter success values
**Effect.filterOrFail(predicate, error)** - Filter or fail with error
**Effect.filterOrElse(predicate, fallback)** - Filter or use fallback
**Effect.partition(items, fn)** - Split into [failures, successes]

## Timing & Delays

**Effect.sleep(duration)** - Non-blocking delay
**Effect.delay(duration)** - Delay before execution
**Effect.timeout(duration)** - Fail with `TimeoutException` if too slow
**Effect.repeat(schedule)** - Re-execute on success

## Racing & Concurrency

**Effect.race(other)** - Race two effects, return first success
**Effect.raceAll(effects)** - Race multiple effects
**Effect.raceFirst(other)** - Race two, return first completion (even failure)

## Combining Effects

**Effect.zip(other)** - Combine into tuple `[a, b]`
**Effect.zipWith(other, fn)** - Combine with custom function

- Use `{ concurrent: true }` for parallel execution

## Common Anti-Patterns

❌ Manual loops with effects → ✅ Effect.forEach/all/iterate/loop
❌ try/finally cleanup → ✅ Effect.addFinalizer/scoped
❌ Promise.all([...]) → ✅ Effect.all([...], { concurrency })
❌ Manual polling loop → ✅ Queue.takeAll or Stream
❌ Plain Map/Object → ✅ HashMap
❌ Plain arrays for mutable state → ✅ Ref.make([...]) or Chunk
❌ Ref for reactive state → ✅ Atom (auto-subscriptions)
❌ Custom event emitters → ✅ Stream/Queue
❌ setTimeout/setInterval → ✅ Effect.sleep/Effect.repeat
❌ null/undefined for optional → ✅ Option.some/none
❌ throw/try-catch → ✅ Effect.fail/catchAll
❌ Manual if-else with effects → ✅ Effect.if/when/unless
❌ Nested callbacks → ✅ Effect.gen with yield\*
❌ Manual fiber management → ✅ FiberSet or Effect.forkIn with Scope
❌ Imaginary methods like `Effect.unit` → ✅ Effect.void (the actual API)
