# EzPath AWS deployment runbook

This runbook is intentionally account-neutral. The infrastructure can be synthesized locally without AWS credentials, but bootstrap, deployment, graph upload, Cognito user creation, and hosting deployment require an authenticated AWS CLI session.

## Resources created

- API Gateway HTTP API and three Python Lambda functions
- versioned private S3 graph bucket
- DynamoDB live-status table and stream
- AppSync Events API with IAM publishing and browser subscription access
- Cognito operator user pool with required TOTP MFA
- Amazon Location map and a browser key limited to map rendering from localhost and the Amplify URL
- Amplify Hosting app and `main` branch configured for manual artifact deployment
- CloudWatch dashboard, logs, publisher retry policy, and dead-letter queue

The routing decision remains in the custom deterministic Lambda. Amazon Location supplies cartography only; it does not decide accessibility feasibility.

## 1. Authenticate and identify the account

Use the project IAM/SSO profile once it has been created. Do not create long-lived root credentials.

```powershell
$env:AWS_PROFILE = "ezpath-deployer"
$env:AWS_REGION = "ap-south-1"
aws sts get-caller-identity
```

Confirm the returned account and ARN before continuing.

## 2. Bootstrap and deploy CDK

From the repository root:

```powershell
Set-Location infra
npm install
npm run synth
npx cdk bootstrap
npx cdk deploy EzPathRoutingStack --outputs-file cdk-outputs.json
Set-Location ..
```

If a new-account Amplify app quota increase is still pending, deploy the AWS core first:

```powershell
npx cdk deploy EzPathRoutingStack `
  --context includeHosting=false `
  --outputs-file cdk-outputs.json
```

After AWS approves the quota, run the normal deploy command without that context flag. CDK then adds Amplify Hosting and updates API Gateway CORS and the Amazon Location key referers to include its generated URL.

`infra/cdk-outputs.json` contains deployment-specific identifiers and the browser AppSync subscriber key. Keep it local and do not commit it.

## 3. Upload the generated routing graph

Build the graph only if `traversal/routing/data/campus.graphml` is not already present. Then use the `GraphBucketName` value from `infra/cdk-outputs.json`:

```powershell
Set-Location traversal/routing
python scripts/upload_graph.py --bucket "<GraphBucketName>"
Set-Location ../..
```

The uploader verifies the manifest and SHA-256 before uploading the graph and manifest to the versioned bucket.

Then build the Chennai timetable artifact and upload it to the same bucket. The API returns HTTP 503 for `POST /v1/journeys` until this object exists:

```powershell
Set-Location traversal/routing
$env:PYTHONPATH = "src"
python scripts/build_transit.py
aws s3 cp data/chennai-transit.json.gz "s3://<GraphBucketName>/transit/chennai-transit.json.gz"
Set-Location ../..
```

Rerun this step whenever a feed under `data/` changes. Running Lambda environments keep the copy they loaded, so redeploy the function after replacing it.

## 4. Generate the production frontend environment

CloudFormation returns the Amazon Location key name, not its browser key value. Retrieve that value with the authenticated profile, then render the ignored `.env.production` file:

```powershell
$locationKey = aws location describe-key `
  --key-name EzPathCampusBrowserMapKey `
  --query Key `
  --output text

python infra/scripts/render_frontend_env.py `
  --outputs infra/cdk-outputs.json `
  --stack EzPathRoutingStack `
  --location-api-key $locationKey `
  --output .env.production
```

The key is intentionally usable from browser code, but its permissions and HTTP referers are restricted. `.env.production`, `infra/cdk-outputs.json`, and generated graph artifacts are excluded from Git.

## 5. Build and manually deploy the frontend

```powershell
npm install
npm run build
Compress-Archive -Path dist\* -DestinationPath ezpath-web.zip -Force
```

In the Amplify console, open the app identified by `AmplifyAppId`, select the `main` branch, and deploy `ezpath-web.zip` using the manual deployment flow. This avoids a GitHub connection and repository access token.

After deployment, open the `AmplifyUrl` output and verify:

1. `/health` returns successfully through API Gateway.
2. A standard walking request returns a route or an explicit no-route response.
3. The map renders through Amazon Location without a referer error.
4. Live event subscription connects.
5. Unauthenticated operator writes remain disabled.

## 6. Create an operator only when needed

Create operators administratively in the Cognito user pool. Self-sign-up is disabled and MFA is required. Use a temporary password, complete the first-login password change, and enroll TOTP before testing protected event creation or resolution.

## Rollback and cost control

`cdk destroy` does not delete the retained graph bucket, DynamoDB table, Cognito user pool, or dead-letter queue. They are retained to avoid accidental data loss and must be reviewed explicitly if the project is retired. The Amazon Location key is non-expiring but referer- and action-restricted; rotate or delete it when the hosted application is no longer used.
