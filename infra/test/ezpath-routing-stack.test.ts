import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { EzPathRoutingStack } from "../lib/ezpath-routing-stack";

function template(): Template {
  const app = new App();
  const stack = new EzPathRoutingStack(app, "TestEzPathRoutingStack");
  return Template.fromStack(stack);
}

function templateWithoutHosting(): Template {
  const app = new App();
  app.node.setContext("includeHosting", "false");
  const stack = new EzPathRoutingStack(app, "TestEzPathRoutingStackWithoutHosting");
  return Template.fromStack(stack);
}

test("creates an encrypted versioned graph bucket", () => {
  template().hasResourceProperties("AWS::S3::Bucket", {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    },
    VersioningConfiguration: { Status: "Enabled" },
  });
});

test("creates the live-status table with TTL and point-in-time recovery", () => {
  template().hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: "PAY_PER_REQUEST",
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
    GlobalSecondaryIndexes: [
      {
        IndexName: "active-events",
        KeySchema: [
          { AttributeName: "activeKey", KeyType: "HASH" },
          { AttributeName: "effectiveStart", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  });
});

test("creates the ZIP-based Python Lambda and both HTTP routes", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "python3.12",
    Handler: "handler.lambda_handler",
    MemorySize: 2048,
    Timeout: 30,
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /health" });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /v1/routes" });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /v1/journeys" });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /v1/telemetry/evidence", AuthorizationType: "NONE",
  });
  assert.ok(rendered.toJSON());
});

test("creates the disruption Lambda and event API routes", () => {
  const rendered = template();
  const applicationFunctions = rendered.findResources("AWS::Lambda::Function", {
    Properties: { Handler: "handler.lambda_handler" },
  });
  assert.equal(Object.keys(applicationFunctions).length, 4);
  rendered.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "python3.12",
    Handler: "handler.lambda_handler",
    MemorySize: 256,
    Timeout: 10,
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /v1/events/active",
    AuthorizationType: "NONE",
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /v1/events",
    AuthorizationType: "JWT",
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /v1/events/{eventId}/resolve",
    AuthorizationType: "JWT",
  });
  for (const path of ["simulate", "confirm"]) {
    rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: `POST /v1/telemetry/${path}`, AuthorizationType: "JWT",
    });
  }
});

test("creates an MFA-protected Cognito operator pool", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Cognito::UserPool", {
    UserPoolName: "ezpath-operators",
    MfaConfiguration: "ON",
    EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
  });
  rendered.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false,
    PreventUserExistenceErrors: "ENABLED",
    AllowedOAuthFlows: ["code"],
    AllowedOAuthScopes: Match.arrayWith(["openid", "email", "profile"]),
  });
  rendered.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
    Domain: Match.anyValue(),
  });
  rendered.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
});

test("creates an AppSync Event API with IAM publish and subscriber-key read access", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::AppSync::Api", {
    Name: "ezpath-events",
    EventConfig: Match.objectLike({
      AuthProviders: Match.arrayWith([
        { AuthType: "AWS_IAM" },
        { AuthType: "API_KEY" },
      ]),
      ConnectionAuthModes: [{ AuthType: "API_KEY" }],
      DefaultPublishAuthModes: [{ AuthType: "AWS_IAM" }],
      DefaultSubscribeAuthModes: [{ AuthType: "API_KEY" }],
    }),
  });
  rendered.hasResourceProperties("AWS::AppSync::ChannelNamespace", {
    Name: "disruptions",
    PublishAuthModes: [{ AuthType: "AWS_IAM" }],
    SubscribeAuthModes: [{ AuthType: "API_KEY" }],
  });
  rendered.resourceCountIs("AWS::AppSync::ApiKey", 1);
});

test("streams status changes through the publisher Lambda with retries and a DLQ", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "python3.12",
    Handler: "handler.lambda_handler",
    MemorySize: 256,
    Timeout: 15,
    Environment: {
      Variables: Match.objectLike({
        EZPATH_APPSYNC_CHANNEL: "/disruptions/network",
      }),
    },
  });
  rendered.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    StartingPosition: "LATEST",
    BatchSize: 5,
    BisectBatchOnFunctionError: true,
    MaximumRetryAttempts: 3,
    DestinationConfig: {
      OnFailure: { Destination: Match.anyValue() },
    },
  });
  rendered.hasResourceProperties("AWS::SQS::Queue", {
    MessageRetentionPeriod: 1209600,
    SqsManagedSseEnabled: true,
  });
  rendered.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "appsync:EventPublish",
          Effect: "Allow",
        }),
      ]),
    },
  });
});

test("creates manual Amplify hosting with SPA routing", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Amplify::App", {
    Name: "ezpath-web",
    Platform: "WEB",
    CustomRules: Match.arrayWith([
      Match.objectLike({ Target: "/index.html", Status: "200" }),
    ]),
  });
  rendered.hasResourceProperties("AWS::Amplify::Branch", {
    BranchName: "main",
    EnableAutoBuild: false,
    EnablePullRequestPreview: false,
    Framework: "React",
    Stage: "PRODUCTION",
  });
  rendered.hasOutput("AmplifyAppId", {});
  rendered.hasOutput("AmplifyUrl", {});
});

test("supports a core deployment while the Amplify quota request is pending", () => {
  const rendered = templateWithoutHosting();
  rendered.resourceCountIs("AWS::Amplify::App", 0);
  rendered.resourceCountIs("AWS::Amplify::Branch", 0);
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: Match.objectLike({ AllowOrigins: ["http://localhost:3000"] }),
  });
  rendered.hasResourceProperties("AWS::Location::APIKey", {
    Restrictions: Match.objectLike({ AllowReferers: ["http://localhost:3000/*"] }),
  });
});

test("restricts the Amazon Location browser key to map rendering and known origins", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Location::Map", {
    MapName: "EzPathSrmCampusMap",
    Configuration: { Style: "VectorEsriNavigation" },
  });
  rendered.hasResourceProperties("AWS::Location::APIKey", {
    KeyName: "EzPathCampusBrowserMapKey",
    ForceUpdate: true,
    NoExpiry: true,
    Restrictions: {
      AllowActions: ["geo:GetMap*"],
      AllowResources: Match.anyValue(),
      AllowReferers: Match.arrayWith(["http://localhost:3000/*"]),
    },
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: Match.objectLike({
      AllowOrigins: Match.arrayWith(["http://localhost:3000"]),
    }),
  });
  rendered.hasOutput("LocationMapName", { Value: "EzPathSrmCampusMap" });
  rendered.hasOutput("LocationApiKeyName", { Value: "EzPathCampusBrowserMapKey" });
  assert.match(JSON.stringify(rendered.toJSON()), /DefaultDomain/);
});

test("creates private expiring report evidence storage and a review queue", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::S3::Bucket", {
    BucketEncryption: Match.anyValue(),
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    LifecycleConfiguration: Match.objectLike({
      Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 90 })]),
    }),
  });
  rendered.hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [{ AttributeName: "reportId", KeyType: "HASH" }],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({ IndexName: "reports-by-status" }),
    ]),
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /v1/reports/upload-request",
    AuthorizationType: "NONE",
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /v1/reports",
    AuthorizationType: "NONE",
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /v1/reports",
    AuthorizationType: "JWT",
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /v1/reports/{reportId}/verify",
    AuthorizationType: "JWT",
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /v1/reports/{reportId}/reject",
    AuthorizationType: "JWT",
  });
});

test("adds satellite imagery, street walking paths and API throttling", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Location::Map", {
    MapName: "EzPathSrmSatelliteMap",
    Configuration: { Style: "RasterEsriImagery" },
  });
  rendered.hasResourceProperties("AWS::Location::RouteCalculator", {
    CalculatorName: "EzPathWalkingRoutes",
    DataSource: "Esri",
  });
  rendered.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Action: "geo:CalculateRoute" })]),
    }),
  });
  rendered.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    DefaultRouteSettings: { ThrottlingBurstLimit: 40, ThrottlingRateLimit: 20 },
  });
});
