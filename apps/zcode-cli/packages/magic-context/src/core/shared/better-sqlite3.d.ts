/**
 * Local structural declaration for the `better-sqlite3` API surface the SQLite
 * chokepoint is typed against.
 *
 * `shared/sqlite.ts` loads `bun:sqlite` or `node:sqlite` at runtime (behind a
 * variable-indirection dynamic import, deliberately) and presents both under
 * this shape. Upstream got these definitions from `@types/better-sqlite3`; this
 * fork takes neither `better-sqlite3` nor its `@types` package as a dependency
 * (zero-native-dependency rule, D-5), so the module the upstream type import
 * names is declared here instead, in the same `export =` + merged-namespace
 * shape that package uses.
 *
 * This declares the runtime surface the ported storage layer actually calls —
 * not the full npm typings. @types/node ships `node:sqlite` typings, but those
 * describe `DatabaseSync`, not the bridge shape the chokepoint presents.
 */
declare module "better-sqlite3" {
    namespace Database {
        interface Options {
            readonly?: boolean;
            fileMustExist?: boolean;
            timeout?: number;
            verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | undefined;
        }

        interface RunResult {
            changes: number;
            lastInsertRowid: number | bigint;
        }

        interface Statement<BindParameters extends unknown[] | {}, Result = unknown> {
            readonly reader: boolean;
            run(...params: BindParameters): RunResult;
            get(...params: BindParameters): Result;
            iterate(...params: BindParameters): IterableIterator<Result>;
            all(...params: BindParameters): Result[];
            pluck(toggle?: boolean): unknown;
            expand(toggle?: boolean): unknown;
            raw(toggle?: boolean): unknown;
            busy(toggle?: boolean): unknown;
            columns(...columnNames: string[]): unknown;
            source(columnName: string): string;
            safeIntegers(toggle?: boolean): unknown;
        }

        type Transaction<F extends (...args: never[]) => unknown = () => void> = ((
            ...args: Parameters<F>
        ) => ReturnType<F>) & {
            default: Transaction<F>;
            deferred: Transaction<F>;
            immediate: Transaction<F>;
            exclusive: Transaction<F>;
            database: Database;
        };

        interface Database {
            readonly name: string;
            readonly open: boolean;
            readonly inTransaction: boolean;
            readonly memory: boolean;
            readonly readonly: boolean;
            prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
                sql: string,
            ): Statement<BindParameters, Result>;
            exec(sql: string): this;
            pragma(...args: unknown[]): unknown;
            close(): this;
            transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>;
            serialize(fn: () => void): this;
            loadExtension(...args: unknown[]): this;
        }

        interface DatabaseConstructor {
            new (filename: string | Buffer, options?: Options): Database;
            (filename: string | Buffer, options?: Options): Database;
            readonly prototype: Database;
        }
    }

    const Database: Database.DatabaseConstructor;

    export = Database;
}
