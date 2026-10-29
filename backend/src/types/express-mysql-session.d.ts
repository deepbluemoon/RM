declare module 'express-mysql-session' {
  import type session from 'express-session';
  interface Options {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    createDatabaseTable?: boolean;
    clearExpired?: boolean;
    checkExpirationInterval?: number;
    schema?: { tableName: string; columnNames: { session_id: string; expires: string; data: string } };
  }
  type MySQLStoreClass = new (options: Options) => session.Store & { close(): Promise<void> };
  export default function MySQLStoreFactory(s: unknown): MySQLStoreClass;
}
