/**
 * The connection forms: every warehouse's fields, sign-in methods and
 * defaults, and the translation between a stored connection and the flat
 * form fields the Connections page edits.
 */

export interface ConnectorFieldSchema {
  key: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'checkbox' | 'select' | 'textarea';
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
  /** Shown only for these sign-in methods (`authMethod` values; '' is the default). */
  authMethods?: string[];
  /** Shown only when the SSH tunnel is switched on. */
  ssh?: boolean;
}

export interface ConnectorFormSchema {
  driver: string;
  label: string;
  fields: ConnectorFieldSchema[];
  /** Fields shown before "Advanced options", per sign-in method ('' is the default method). */
  primary?: (authMethod: string) => string[];
}

export const DRIVER_LABELS: Record<string, string> = {
  duckdb: 'DuckDB',
  file: 'Local File / DuckDB',
  sqlite: 'SQLite',
  snowflake: 'Snowflake',
  databricks: 'Databricks',
  bigquery: 'BigQuery',
  postgresql: 'PostgreSQL',
  redshift: 'Amazon Redshift',
  mysql: 'MySQL / MariaDB',
  mssql: 'SQL Server',
  fabric: 'Microsoft Fabric',
  trino: 'Trino / Starburst',
  clickhouse: 'ClickHouse',
  athena: 'Amazon Athena',
};

export const DRIVER_COLORS: Record<string, string> = {
  duckdb: '#f4bc00',
  file: '#f4bc00',
  sqlite: '#0f80cc',
  snowflake: '#29b5e8',
  databricks: '#ff3621',
  bigquery: '#4285f4',
  postgresql: '#336791',
  redshift: '#8c4fff',
  mysql: '#00758f',
  mssql: '#cc2927',
  fabric: '#117865',
  trino: '#dd00a1',
  clickhouse: '#faff69',
  athena: '#8c4fff',
};

// Short one-line blurbs for the driver cards.
export const DRIVER_TAGLINES: Record<string, string> = {
  duckdb: 'In-process analytical database',
  file: 'Local CSV / Parquet via DuckDB',
  sqlite: 'Local database file',
  snowflake: 'Cloud data platform',
  databricks: 'Lakehouse platform',
  bigquery: 'Google Cloud data warehouse',
  postgresql: 'PostgreSQL, RDS, Aurora, Cloud SQL, Supabase',
  redshift: 'AWS data warehouse, provisioned or Serverless',
  mysql: 'MySQL, MariaDB, RDS, Aurora, PlanetScale',
  mssql: 'SQL Server and Azure SQL',
  fabric: 'Fabric warehouse / SQL endpoint',
  trino: 'Federated SQL over your lake',
  clickhouse: 'Real-time analytics, self-hosted or Cloud',
  athena: 'Serverless SQL over S3',
};

// Settings every network database shares: TLS the way libpq names it, and an
// SSH bastion for databases inside a private network.
const TLS_MODE_FIELD: ConnectorFieldSchema = {
  key: 'sslMode',
  label: 'TLS / SSL',
  type: 'select',
  options: [
    { value: 'disable', label: 'Off' },
    { value: 'require', label: 'Encrypt (require)' },
    { value: 'verify-ca', label: 'Encrypt + verify CA' },
    { value: 'verify-full', label: 'Encrypt + verify CA and host name' },
  ],
  helpText: 'Production databases should verify the certificate. Managed services (RDS, Azure, Cloud SQL) publish their CA bundle.',
};
const TLS_ROOT_CERT_FIELD: ConnectorFieldSchema = {
  key: 'sslRootCert',
  label: 'CA certificate',
  type: 'text',
  placeholder: '~/certs/rds-global-bundle.pem',
  helpText: 'A PEM file path (or pasted PEM) used to verify the server.',
};
const SSH_FIELDS: ConnectorFieldSchema[] = [
  { key: 'useSshTunnel', label: 'Connect through an SSH tunnel', type: 'checkbox', helpText: 'For a database that is only reachable from a bastion host.' },
  { key: 'sshTunnel.host', label: 'SSH host', type: 'text', placeholder: 'bastion.example.com', ssh: true },
  { key: 'sshTunnel.port', label: 'SSH port', type: 'number', placeholder: '22', ssh: true },
  { key: 'sshTunnel.username', label: 'SSH user', type: 'text', placeholder: 'ec2-user', ssh: true },
  { key: 'sshTunnel.privateKeyPath', label: 'SSH private key file', type: 'text', placeholder: '~/.ssh/id_ed25519', ssh: true },
  { key: 'sshTunnel.passphrase', label: 'Key passphrase', type: 'password', ssh: true },
  { key: 'sshTunnel.password', label: 'SSH password', type: 'password', helpText: 'Only when the bastion does not accept keys.', ssh: true },
];
const AWS_AUTH_OPTIONS = [
  { value: 'aws_default', label: 'AWS default credentials (SSO, env, role)' },
  { value: 'aws_profile', label: 'AWS named profile' },
  { value: 'aws_access_key', label: 'AWS access key' },
];
const AWS_METHODS = ['aws_default', 'aws_profile', 'aws_access_key'];
const AWS_FIELDS: ConnectorFieldSchema[] = [
  { key: 'region', label: 'AWS region', type: 'text', placeholder: 'us-east-1', authMethods: AWS_METHODS },
  { key: 'profile', label: 'AWS profile', type: 'text', placeholder: 'analytics', authMethods: ['aws_profile'] },
  { key: 'accessKeyId', label: 'Access key ID', type: 'text', authMethods: ['aws_access_key'] },
  { key: 'secretAccessKey', label: 'Secret access key', type: 'password', authMethods: ['aws_access_key'] },
  { key: 'sessionToken', label: 'Session token', type: 'password', authMethods: ['aws_access_key'], helpText: 'Only for temporary (STS) keys.' },
];
const QUERY_TIMEOUT_FIELD: ConnectorFieldSchema = { key: 'timeout', label: 'Connect timeout (seconds)', type: 'number', placeholder: '20' };
const APPLICATION_FIELD: ConnectorFieldSchema = { key: 'application', label: 'Application name', type: 'text', placeholder: 'dql', helpText: 'Shown to DBAs in session and query history.' };

export const CONNECTOR_SCHEMAS: ConnectorFormSchema[] = [
  {
    driver: 'duckdb',
    label: 'DuckDB',
    fields: [
      { key: 'filepath', label: 'DuckDB file path', type: 'text', placeholder: './local/dev.duckdb', required: true },
    ],
  },
  {
    driver: 'snowflake',
    label: 'Snowflake',
    fields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'warehouse', label: 'Warehouse', type: 'text', required: true },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'schema', label: 'Schema', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text', required: true },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'password', label: 'Password' },
          { value: 'mfa', label: 'Password + MFA' },
          { value: 'key_pair', label: 'Key pair / private key' },
          { value: 'external_browser', label: 'SSO / external browser' },
          { value: 'oauth', label: 'OAuth token' },
          { value: 'oauth_authorization_code', label: 'OAuth authorization code' },
          { value: 'oauth_client_credentials', label: 'OAuth client credentials' },
          { value: 'programmatic_access_token', label: 'Programmatic access token' },
          { value: 'workload_identity', label: 'Workload identity' },
        ],
      },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'token', label: 'Token', type: 'password', helpText: 'OAuth, programmatic access token, or OIDC workload identity token.' },
      { key: 'privateKeyPath', label: 'Private key file path', type: 'text', placeholder: '~/.ssh/snowflake_key.p8' },
      { key: 'privateKey', label: 'Private key PEM', type: 'textarea', helpText: 'Paste PEM only when a key file cannot be referenced.' },
      { key: 'privateKeyPassphrase', label: 'Private key passphrase', type: 'password' },
      { key: 'authenticator', label: 'Authenticator override', type: 'text', placeholder: 'EXTERNALBROWSER, OAUTH, WORKLOAD_IDENTITY, or Okta URL' },
      { key: 'role', label: 'Role', type: 'text' },
      { key: 'accessUrl', label: 'Access URL', type: 'text' },
      { key: 'application', label: 'Application name', type: 'text', placeholder: 'DQL' },
      { key: 'queryTag', label: 'Query tag', type: 'text', placeholder: 'team=analytics;app=dql' },
      { key: 'passcode', label: 'MFA passcode', type: 'password' },
      { key: 'passcodeInPassword', label: 'MFA passcode is appended to password', type: 'checkbox' },
      { key: 'clientRequestMFAToken', label: 'Reuse cached MFA token', type: 'checkbox' },
      { key: 'clientStoreTemporaryCredential', label: 'Cache SSO token locally', type: 'checkbox' },
      { key: 'clientSessionKeepAlive', label: 'Keep session alive', type: 'checkbox' },
      { key: 'clientSessionKeepAliveHeartbeatFrequency', label: 'Keep-alive heartbeat seconds', type: 'number', placeholder: '3600' },
      { key: 'credentialCacheDir', label: 'Credential cache directory', type: 'text' },
      { key: 'browserActionTimeout', label: 'Browser SSO timeout ms', type: 'number', placeholder: '120000' },
      { key: 'keepAlive', label: 'Socket keep-alive', type: 'checkbox' },
      { key: 'timeout', label: 'Connection timeout ms', type: 'number', placeholder: '60000' },
      { key: 'proxyHost', label: 'Proxy host', type: 'text' },
      { key: 'proxyPort', label: 'Proxy port', type: 'number' },
      { key: 'proxyProtocol', label: 'Proxy protocol', type: 'text', placeholder: 'https' },
      { key: 'proxyUser', label: 'Proxy user', type: 'text' },
      { key: 'proxyPassword', label: 'Proxy password', type: 'password' },
      { key: 'noProxy', label: 'No proxy hosts', type: 'text', placeholder: '*.amazonaws.com|*.internal' },
      { key: 'oauthClientId', label: 'OAuth client ID', type: 'text' },
      { key: 'oauthClientSecret', label: 'OAuth client secret', type: 'password' },
      { key: 'oauthAuthorizationUrl', label: 'OAuth authorization URL', type: 'text' },
      { key: 'oauthTokenRequestUrl', label: 'OAuth token request URL', type: 'text' },
      { key: 'oauthScope', label: 'OAuth scope', type: 'text' },
      { key: 'oauthRedirectUri', label: 'OAuth redirect URI', type: 'text' },
      { key: 'workloadIdentityProvider', label: 'Workload identity provider', type: 'text', placeholder: 'AWS, AZURE, GCP, or OIDC' },
      { key: 'workloadIdentityAzureClientId', label: 'Azure client ID', type: 'text' },
    ],
  },
  {
    driver: 'databricks',
    label: 'Databricks SQL',
    fields: [
      { key: 'host', label: 'Workspace URL', type: 'text', required: true, placeholder: 'https://adb-123.cloud.databricks.com' },
      { key: 'database', label: 'Catalog / database', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      { key: 'warehouse', label: 'Warehouse ID', type: 'text', helpText: 'Use the SQL warehouse ID when you have it.' },
      { key: 'httpPath', label: 'SQL warehouse ID or path', type: 'text', placeholder: '/sql/1.0/warehouses/abc123', helpText: 'Paste the warehouse ID or its JDBC/HTTP path.' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'token', label: 'Access token' },
          { value: 'oauth', label: 'OAuth bearer token' },
        ],
      },
      { key: 'token', label: 'Bearer token', type: 'password', required: true, helpText: 'Use an OAuth token for automation when possible, or a service-principal PAT.' },
      { key: 'waitTimeout', label: 'Statement wait timeout', type: 'text', placeholder: '50s' },
      { key: 'byteLimit', label: 'Inline byte limit', type: 'number', placeholder: '25000000' },
    ],
  },
  {
    driver: 'bigquery',
    label: 'BigQuery',
    primary: (auth) => [
      'projectId', 'location', 'schema', 'authMethod',
      ...(auth === 'service_account_key_file' ? ['keyFilename'] : auth === 'service_account_json' ? ['serviceAccountJson'] : []),
    ],
    fields: [
      { key: 'projectId', label: 'Billing project', type: 'text', required: true, placeholder: 'my-gcp-project', helpText: 'The project queries run and are billed in.' },
      { key: 'location', label: 'Location', type: 'text', placeholder: 'US', helpText: 'Where your datasets live: US, EU, or a region such as us-east1.' },
      { key: 'schema', label: 'Default dataset', type: 'text', placeholder: 'analytics' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'application_default', label: 'Google sign-in (gcloud application-default login)' },
          { value: 'service_account_key_file', label: 'Service account key file' },
          { value: 'service_account_json', label: 'Service account key JSON' },
        ],
      },
      { key: 'keyFilename', label: 'Key file path', type: 'text', placeholder: '~/keys/dql-reader.json', authMethods: ['service_account_key_file'] },
      { key: 'serviceAccountJson', label: 'Key JSON', type: 'textarea', authMethods: ['service_account_json'], helpText: 'Stored in the project\'s private secrets file, never in dql.config.json.' },
      { key: 'byteLimit', label: 'Maximum bytes billed per query', type: 'number', placeholder: '10000000000', helpText: 'BigQuery refuses a query that would scan more, instead of billing it.' },
      QUERY_TIMEOUT_FIELD,
      { key: 'host', label: 'API endpoint override', type: 'text', placeholder: 'https://bigquery.googleapis.com', helpText: 'Only for Private Service Connect or an emulator.' },
    ],
  },
  {
    driver: 'postgresql',
    label: 'PostgreSQL',
    primary: (auth) => ['host', 'port', 'database', 'username', 'authMethod', ...(AWS_METHODS.includes(auth) ? ['region'] : ['password']), 'sslMode'],
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.example.com' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '5432' },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'username', label: 'User', type: 'text', required: true, helpText: 'A read-only role is recommended.' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [{ value: 'password', label: 'Password' }, ...AWS_AUTH_OPTIONS.map((option) => ({ ...option, label: `RDS IAM — ${option.label}` }))],
      },
      { key: 'password', label: 'Password', type: 'password', authMethods: ['', 'password'] },
      ...AWS_FIELDS,
      TLS_MODE_FIELD,
      TLS_ROOT_CERT_FIELD,
      ...SSH_FIELDS,
      QUERY_TIMEOUT_FIELD,
      APPLICATION_FIELD,
      { key: 'connectionString', label: 'Connection URL (instead of the fields above)', type: 'password', placeholder: 'postgresql://user@host:5432/db' },
    ],
  },
  {
    driver: 'redshift',
    label: 'Amazon Redshift',
    primary: (auth) => [
      'host', 'port', 'database', 'authMethod',
      ...(AWS_METHODS.includes(auth) ? ['clusterId', 'workgroup', 'username', 'region'] : ['username', 'password']),
      ...(auth === 'aws_profile' ? ['profile'] : auth === 'aws_access_key' ? ['accessKeyId', 'secretAccessKey'] : []),
    ],
    fields: [
      { key: 'host', label: 'Endpoint', type: 'text', required: true, placeholder: 'my-cluster.abc123.us-east-1.redshift.amazonaws.com' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '5439' },
      { key: 'database', label: 'Database', type: 'text', required: true, placeholder: 'dev' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [{ value: 'password', label: 'Database user and password' }, ...AWS_AUTH_OPTIONS.map((option) => ({ ...option, label: `IAM — ${option.label}` }))],
      },
      { key: 'username', label: 'Database user', type: 'text', helpText: 'For IAM on a provisioned cluster, the database user to sign in as.' },
      { key: 'password', label: 'Password', type: 'password', authMethods: ['', 'password'] },
      { key: 'clusterId', label: 'Cluster identifier', type: 'text', placeholder: 'my-cluster', authMethods: AWS_METHODS, helpText: 'Provisioned clusters. Leave empty for Serverless.' },
      { key: 'workgroup', label: 'Serverless workgroup', type: 'text', placeholder: 'default-workgroup', authMethods: AWS_METHODS, helpText: 'Redshift Serverless only.' },
      ...AWS_FIELDS,
      TLS_MODE_FIELD,
      TLS_ROOT_CERT_FIELD,
      ...SSH_FIELDS,
      QUERY_TIMEOUT_FIELD,
      APPLICATION_FIELD,
    ],
  },
  {
    driver: 'mysql',
    label: 'MySQL / MariaDB',
    primary: () => ['host', 'port', 'database', 'username', 'password', 'sslMode'],
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.example.com' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '3306' },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'username', label: 'User', type: 'text', required: true, helpText: 'A read-only user is recommended.' },
      { key: 'password', label: 'Password', type: 'password' },
      TLS_MODE_FIELD,
      TLS_ROOT_CERT_FIELD,
      ...SSH_FIELDS,
      QUERY_TIMEOUT_FIELD,
      { key: 'connectionString', label: 'Connection URL (instead of the fields above)', type: 'password', placeholder: 'mysql://user@host:3306/db' },
    ],
  },
  {
    driver: 'mssql',
    label: 'SQL Server / Azure SQL',
    primary: (auth) => [
      'host', 'port', 'database', 'authMethod',
      ...(auth === 'azure_default' ? [] : auth === 'azure_service_principal' ? ['oauthClientId', 'oauthClientSecret', 'tenantId'] : ['username', 'password']),
      'sslMode', 'trustServerCertificate',
    ],
    fields: [
      { key: 'host', label: 'Server', type: 'text', required: true, placeholder: 'myserver.database.windows.net' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '1433' },
      { key: 'database', label: 'Database', type: 'text', required: true },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'password', label: 'SQL login' },
          { value: 'azure_password', label: 'Microsoft Entra ID user and password' },
          { value: 'azure_default', label: 'Microsoft Entra ID — az login, managed identity, environment' },
          { value: 'azure_service_principal', label: 'Microsoft Entra ID — service principal' },
        ],
      },
      { key: 'username', label: 'User', type: 'text', authMethods: ['', 'password', 'azure_password'] },
      { key: 'password', label: 'Password', type: 'password', authMethods: ['', 'password', 'azure_password'] },
      { key: 'oauthClientId', label: 'Client (application) ID', type: 'text', authMethods: ['azure_service_principal', 'azure_default', 'azure_password'] },
      { key: 'oauthClientSecret', label: 'Client secret', type: 'password', authMethods: ['azure_service_principal'] },
      { key: 'tenantId', label: 'Tenant ID', type: 'text', authMethods: ['azure_service_principal', 'azure_password'] },
      { ...TLS_MODE_FIELD, helpText: 'Encrypted and certificate-checked by default.' },
      { key: 'trustServerCertificate', label: 'Trust the server certificate', type: 'checkbox', helpText: 'Only for a server with a self-signed certificate on a network you trust.' },
      TLS_ROOT_CERT_FIELD,
      ...SSH_FIELDS,
      QUERY_TIMEOUT_FIELD,
      APPLICATION_FIELD,
    ],
  },
  {
    driver: 'trino',
    label: 'Trino / Starburst',
    primary: (auth) => ['host', 'port', 'catalog', 'schema', 'username', 'authMethod', ...(auth === 'token' ? ['token'] : ['password']), 'ssl'],
    fields: [
      { key: 'host', label: 'Coordinator host', type: 'text', required: true, placeholder: 'trino.example.com' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '443 (HTTPS) or 8080' },
      { key: 'catalog', label: 'Catalog', type: 'text', required: true, placeholder: 'hive' },
      { key: 'schema', label: 'Schema', type: 'text', placeholder: 'analytics' },
      { key: 'username', label: 'User', type: 'text', required: true },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'password', label: 'Password (LDAP / file)' },
          { value: 'token', label: 'JWT / OAuth access token' },
        ],
      },
      { key: 'password', label: 'Password', type: 'password', authMethods: ['', 'password'], helpText: 'Trino only accepts a password over HTTPS.' },
      { key: 'token', label: 'Access token', type: 'password', authMethods: ['token'] },
      { key: 'ssl', label: 'Use HTTPS', type: 'checkbox' },
      APPLICATION_FIELD,
    ],
  },
  {
    driver: 'clickhouse',
    label: 'ClickHouse',
    primary: () => ['host', 'port', 'database', 'username', 'password', 'ssl'],
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'abc123.us-east-1.aws.clickhouse.cloud' },
      { key: 'port', label: 'HTTP(S) port', type: 'number', placeholder: '8443 (HTTPS) or 8123' },
      { key: 'database', label: 'Database', type: 'text', placeholder: 'default' },
      { key: 'username', label: 'User', type: 'text', placeholder: 'default', helpText: 'A readonly user is recommended.' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'ssl', label: 'Use HTTPS', type: 'checkbox', helpText: 'Required for ClickHouse Cloud.' },
    ],
  },
  {
    driver: 'athena',
    label: 'Amazon Athena',
    primary: (auth) => [
      'region', 'workgroup', 'database', 'outputLocation', 'authMethod',
      ...(auth === 'aws_profile' ? ['profile'] : auth === 'aws_access_key' ? ['accessKeyId', 'secretAccessKey'] : []),
    ],
    fields: [
      { key: 'region', label: 'AWS region', type: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'workgroup', label: 'Workgroup', type: 'text', placeholder: 'primary' },
      { key: 'database', label: 'Database', type: 'text', placeholder: 'analytics' },
      { key: 'catalog', label: 'Data catalog', type: 'text', placeholder: 'AwsDataCatalog' },
      { key: 'outputLocation', label: 'Query results location', type: 'text', placeholder: 's3://my-athena-results/dql/', helpText: 'Needed unless the workgroup sets one.' },
      { key: 'authMethod', label: 'Authentication', type: 'select', options: AWS_AUTH_OPTIONS },
      ...AWS_FIELDS.filter((field) => field.key !== 'region'),
      QUERY_TIMEOUT_FIELD,
    ],
  },
  {
    driver: 'fabric',
    label: 'Microsoft Fabric',
    primary: (auth) => ['host', 'database', 'authMethod', ...(auth === 'azure_service_principal' ? ['oauthClientId', 'oauthClientSecret', 'tenantId'] : auth === 'azure_password' ? ['username', 'password'] : [])],
    fields: [
      { key: 'host', label: 'SQL connection string host', type: 'text', required: true, placeholder: 'abc.datawarehouse.fabric.microsoft.com' },
      { key: 'database', label: 'Warehouse / lakehouse', type: 'text', required: true },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'azure_default', label: 'Microsoft Entra ID — az login, managed identity, environment' },
          { value: 'azure_service_principal', label: 'Microsoft Entra ID — service principal' },
          { value: 'azure_password', label: 'Microsoft Entra ID user and password' },
        ],
      },
      { key: 'username', label: 'User', type: 'text', authMethods: ['azure_password'] },
      { key: 'password', label: 'Password', type: 'password', authMethods: ['azure_password'] },
      { key: 'oauthClientId', label: 'Client (application) ID', type: 'text', authMethods: ['azure_service_principal', 'azure_default', 'azure_password'] },
      { key: 'oauthClientSecret', label: 'Client secret', type: 'password', authMethods: ['azure_service_principal'] },
      { key: 'tenantId', label: 'Tenant ID', type: 'text', authMethods: ['azure_service_principal', 'azure_password'] },
      QUERY_TIMEOUT_FIELD,
    ],
  },
  {
    driver: 'sqlite',
    label: 'SQLite',
    fields: [
      { key: 'filepath', label: 'SQLite file path', type: 'text', placeholder: './data/app.sqlite', required: true, helpText: 'Opened read-only.' },
    ],
  },
  {
    driver: 'file',
    label: 'Local files',
    fields: [
      { key: 'dataFolder', label: 'Data folder', type: 'text', placeholder: './data', required: true, helpText: 'Each CSV, TSV, Parquet or JSON file in the folder is a table named after the file. The files are read where they are.' },
    ],
  },
];

/** Whether a field applies to the form's current sign-in method and tunnel switch. */
export function fieldApplies(field: ConnectorFieldSchema, fields: Record<string, string>): boolean {
  if (field.ssh && fields.useSshTunnel !== 'true') return false;
  if (field.authMethods && !field.authMethods.includes(fields.authMethod ?? '')) return false;
  return true;
}

/** A stored connection as flat form fields: `sshTunnel: {host}` becomes `sshTunnel.host`. */
export function formFieldsFromConnection(cfg: Record<string, unknown> | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  Object.entries(cfg ?? {}).forEach(([key, value]) => {
    if (key === 'driver' || key === 'type' || value === undefined || value === null) return;
    if (key === 'sshTunnel' && typeof value === 'object') {
      fields.useSshTunnel = 'true';
      Object.entries(value as Record<string, unknown>).forEach(([inner, nested]) => {
        if (nested !== undefined && nested !== null) fields[`sshTunnel.${inner}`] = String(nested);
      });
      return;
    }
    fields[normalizeFieldName(key)] = String(value);
  });
  return fields;
}
export const CONNECTOR_SCHEMA_BY_DRIVER = Object.fromEntries(
  CONNECTOR_SCHEMAS.map((schema) => [schema.driver, schema]),
) as Record<string, ConnectorFormSchema>;

export function normalizeDriverName(driver: string): string {
  return driver === 'postgres' ? 'postgresql' : driver;
}

export function normalizeFieldName(field: string): string {
  const aliases: Record<string, string> = {
    dbname: 'database',
    dataset: 'schema',
    access_url: 'accessUrl',
    auth_method: 'authMethod',
    auth_type: 'authMethod',
    browser_action_timeout: 'browserActionTimeout',
    byte_limit: 'byteLimit',
    client_request_mfa_token: 'clientRequestMFAToken',
    client_session_keep_alive: 'clientSessionKeepAlive',
    client_session_keep_alive_heartbeat_frequency: 'clientSessionKeepAliveHeartbeatFrequency',
    client_store_temporary_credential: 'clientStoreTemporaryCredential',
    credential_cache_dir: 'credentialCacheDir',
    http_path: 'httpPath',
    keep_alive: 'keepAlive',
    keyFile: 'keyFilename',
    keyFileName: 'keyFilename',
    no_proxy: 'noProxy',
    oauth_authorization_url: 'oauthAuthorizationUrl',
    oauth_client_id: 'oauthClientId',
    oauth_client_secret: 'oauthClientSecret',
    oauth_redirect_uri: 'oauthRedirectUri',
    oauth_scope: 'oauthScope',
    oauth_token_request_url: 'oauthTokenRequestUrl',
    passcode_in_password: 'passcodeInPassword',
    private_key: 'privateKey',
    private_key_path: 'privateKeyPath',
    private_key_passphrase: 'privateKeyPassphrase',
    proxy_host: 'proxyHost',
    proxy_password: 'proxyPassword',
    proxy_port: 'proxyPort',
    proxy_protocol: 'proxyProtocol',
    proxy_user: 'proxyUser',
    query_tag: 'queryTag',
    path: 'filepath',
    project: 'projectId',
    server: 'host',
    server_hostname: 'host',
    user: 'username',
    wait_timeout: 'waitTimeout',
    workload_identity_azure_client_id: 'workloadIdentityAzureClientId',
    workload_identity_provider: 'workloadIdentityProvider',
  };
  return aliases[field] ?? field;
}

/**
 * The connection a form saves: typed values, fields of another sign-in
 * method (or a switched-off tunnel) left out, and `sshTunnel.*` fields
 * folded into one `sshTunnel` object.
 */
export function connectionFromFormFields(driver: string, fields: Record<string, string>): Record<string, unknown> {
  const connection: Record<string, unknown> = { driver };
  const schema = CONNECTOR_SCHEMA_BY_DRIVER[driver];
  const fieldSchemas = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
  const tunnel: Record<string, unknown> = {};
  Object.entries(fields).forEach(([key, raw]) => {
    const fieldSchema = fieldSchemas.get(key);
    if (fieldSchema && !fieldApplies(fieldSchema, fields)) return;
    if (key === 'useSshTunnel') return;
    let value: unknown;
    if (fieldSchema?.type === 'checkbox') {
      if (raw === '') return;
      value = raw === 'true';
    } else {
      const trimmed = raw.trim();
      if (!trimmed) return;
      value = fieldSchema?.type === 'number' && !isNaN(Number(trimmed)) ? Number(trimmed) : trimmed;
    }
    if (key.startsWith('sshTunnel.')) tunnel[key.slice('sshTunnel.'.length)] = value;
    else connection[key] = value;
  });
  if (fields.useSshTunnel === 'true' && tunnel.host) connection.sshTunnel = tunnel;
  return connection;
}
