import type * as Cause from "effect/Cause";
import type * as Deferred from "effect/Deferred";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as FiberMap from "effect/FiberMap";
import type * as Stream from "effect/Stream";

type ValidEffect = Effect.Effect<string, Error, never>;
type ValidStream = Stream.Stream<string, Error, never>;
type ValidFiber = Fiber.Fiber<string, Error>;
type ValidDeferred = Deferred.Deferred<string, Error>;
type ValidFiberMap = FiberMap.FiberMap<string, string, Error>;
type ValidCause = Cause.Cause<Error>;
type GenericEffect<E, R> = Effect.Effect<string, E, R>;

type UnknownEffectError = Effect.Effect<string, unknown, never>;
type AnyEffectRequirements = Effect.Effect<string, Error, any>;
type UnknownStreamError = Stream.Stream<string, unknown>;
type AnyFiberError = Fiber.Fiber<string, any>;
type UnknownDeferredError = Deferred.Deferred<string, unknown>;
type AnyFiberMapError = FiberMap.FiberMap<string, string, any>;
type UnknownCause = Cause.Cause<unknown>;
