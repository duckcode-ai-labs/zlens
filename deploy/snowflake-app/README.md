# The ZLens app for Snowflake (free, one person)

ZLens packaged as a Snowflake Native App with containers. The customer installs it in their own
account; ZLens runs there (Snowpark Container Services), reads only the tables they grant the app,
signs people in through Snowflake (only the one named user), keeps its project on a block volume,
and uses Claude through Snowflake Cortex. What the customer's admin runs is in `app/README.md`.

## Build and install it (in your own account, development mode)

1. Build the image for Snowflake's platform, with the Snowflake driver baked in, and push it to an
   image repository in your account (`CREATE IMAGE REPOSITORY ...`):

   ```bash
   docker build --platform linux/amd64 --build-arg ZLENS_DRIVERS="snowflake-sdk@^3.4.1" -t zlens-snowflake .
   snow spcs image-registry login
   docker tag zlens-snowflake <orgname>-<acctname>.registry.snowflakecomputing.com/<db>/<schema>/<repo>/zlens:<tag>
   docker push <orgname>-<acctname>.registry.snowflakecomputing.com/<db>/<schema>/<repo>/zlens:<tag>
   ```

2. From this folder, with a Snowflake CLI connection for a role that may create application packages:

   ```bash
   ZLENS_IMAGE=/<db>/<schema>/<repo>/zlens:<tag> snow app run
   ```

3. Then follow `app/README.md` as the consumer (grants, `start_app`, `app_url`).

Inside the container, ZLens trusts Snowflake's `Sf-Context-Current-User` header only because the
Snowflake ingress sets it (a client's own copy is replaced); outside a Snowflake container that
mode never turns on (`apps/cli/src/snowflake-ingress.ts`).
