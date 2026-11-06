import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  Expiration,
  RemovalPolicy,
  Size,
  Stack,
  StackProps,
  aws_apigatewayv2 as apigatewayv2,
  aws_amplify as amplify,
  aws_appsync as appsync,
  aws_cloudwatch as cloudwatch,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_location as location,
  aws_s3 as s3,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";

export class EzPathRoutingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const includeHosting = this.node.tryGetContext("includeHosting") !== "false";

    let hostingApp: amplify.CfnApp | undefined;
    let hostingBranch: amplify.CfnBranch | undefined;
    let hostingUrl: string | undefined;

    if (includeHosting) {
      hostingApp = new amplify.CfnApp(this, "HostingApp", {
        name: "ezpath-web",
        platform: "WEB",
        description: "Manual static hosting for the EzPath web application",
        customRules: [
          {
            source:
              "</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|json|map|png|svg|txt|webmanifest|woff|woff2)$)([^.]+$)/>",
            target: "/index.html",
            status: "200",
          },
        ],
      });
      hostingBranch = new amplify.CfnBranch(this, "HostingBranch", {
        appId: hostingApp.attrAppId,
        branchName: "main",
        description: "Production branch deployed from a local build artifact",
        enableAutoBuild: false,
        enablePullRequestPreview: false,
        framework: "React",
        stage: "PRODUCTION",
      });
      hostingUrl = `https://${hostingBranch.attrBranchName}.${hostingApp.attrDefaultDomain}`;
    }

    const graphBucket = new s3.Bucket(this, "GraphBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const reportBucket = new s3.Bucket(this, "ReportBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedHeaders: ["content-type"],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["http://localhost:3000", ...(hostingUrl ? [hostingUrl] : [])],
          maxAge: 300,
        },
      ],
      lifecycleRules: [{ expiration: Duration.days(90) }],
    });

    const statusTable = new dynamodb.Table(this, "StatusTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: "expiresAt",
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    statusTable.addGlobalSecondaryIndex({
      indexName: "active-events",
      partitionKey: { name: "activeKey", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "effectiveStart", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const reportsTable = new dynamodb.Table(this, "ReportsTable", {
      partitionKey: { name: "reportId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    reportsTable.addGlobalSecondaryIndex({
      indexName: "reports-by-status",
      partitionKey: { name: "statusKey", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "submittedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const operatorUserPool = new cognito.UserPool(this, "OperatorUserPool", {
      userPoolName: "ezpath-operators",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const operatorDomain = operatorUserPool.addDomain("OperatorDomain", {
      cognitoDomain: {
        domainPrefix: `ezpath-operators-${this.account}`,
      },
    });
    const operatorClient = operatorUserPool.addClient("OperatorWebClient", {
      authFlows: { userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          "http://localhost:3000/operator/callback",
          ...(hostingUrl ? [`${hostingUrl}/operator/callback`] : []),
        ],
        logoutUrls: [
          "http://localhost:3000/operator",
          ...(hostingUrl ? [`${hostingUrl}/operator`] : []),
        ],
      },
    });

    const campusMap = new location.CfnMap(this, "CampusMap", {
      mapName: "EzPathSrmCampusMap",
      description: "Basemap for the SRM Kattankulathur journey planner",
      configuration: { style: "VectorEsriNavigation" },
    });
    const satelliteMap = new location.CfnMap(this, "SatelliteMap", {
      mapName: "EzPathSrmSatelliteMap",
      description: "Satellite imagery for the Chennai and SRM journey planner",
      configuration: { style: "RasterEsriImagery" },
    });
    const walkingCalculator = new location.CfnRouteCalculator(this, "WalkingCalculator", {
      calculatorName: "EzPathWalkingRoutes",
      dataSource: "Esri",
      description: "Street walking paths between stops outside the campus graph",
    });
    const campusMapKey = new location.CfnAPIKey(this, "CampusMapKey", {
      keyName: "EzPathCampusBrowserMapKey",
      description: "Referer-restricted browser key for rendering the EzPath campus map",
      forceUpdate: true,
      noExpiry: true,
      restrictions: {
        allowActions: ["geo:GetMap*"],
        allowResources: [campusMap.attrArn, satelliteMap.attrArn],
        allowReferers: [
          "http://localhost:3000/*",
          ...(hostingUrl ? [`${hostingUrl}/*`] : []),
        ],
      },
    });

    const eventsApi = new appsync.EventApi(this, "EventsApi", {
      apiName: "ezpath-events",
      authorizationConfig: {
        authProviders: [
          { authorizationType: appsync.AppSyncAuthorizationType.IAM },
          {
            authorizationType: appsync.AppSyncAuthorizationType.API_KEY,
            apiKeyConfig: {
              name: "SubscriberKey",
              description: "Read-only browser subscriptions for the EzPath prototype",
              expires: Expiration.after(Duration.days(30)),
            },
          },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
      },
      logConfig: {
        excludeVerboseContent: true,
        fieldLogLevel: appsync.AppSyncFieldLogLevel.ERROR,
        retention: logs.RetentionDays.ONE_WEEK,
      },
    });
    const disruptionNamespace = eventsApi.addChannelNamespace("DisruptionNamespace", {
      channelNamespaceName: "disruptions",
      authorizationConfig: {
        publishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        subscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
      },
    });

    const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
    const routePackage = path.join(repositoryRoot, ".build", "route_lambda");
    const routeFunction = new lambda.Function(this, "RouteFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.lambda_handler",
      code: lambda.Code.fromAsset(routePackage),
      architecture: lambda.Architecture.X86_64,
      description: "Deterministic accessibility-aware routing service",
      environment: {
        EZPATH_GRAPH_BUCKET: graphBucket.bucketName,
        EZPATH_GRAPH_KEY: "graphs/campus.graphml",
        EZPATH_GRAPH_PATH: "/tmp/ezpath/campus.graphml",
        EZPATH_TRANSIT_KEY: "transit/chennai-transit.json.gz",
        EZPATH_TRANSIT_PATH: "/tmp/ezpath/chennai-transit.json.gz",
        EZPATH_ROUTE_CALCULATOR: walkingCalculator.calculatorName,
        EZPATH_STATUS_TABLE: statusTable.tableName,
      },
      ephemeralStorageSize: Size.mebibytes(1024),
      memorySize: 2048,
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(this, "RouteFunctionLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    graphBucket.grantRead(routeFunction);
    statusTable.grantReadData(routeFunction);
    routeFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["geo:CalculateRoute"],
      resources: [walkingCalculator.attrArn],
    }));

    const disruptionPackage = path.join(repositoryRoot, ".build", "disruption_lambda");
    const disruptionFunction = new lambda.Function(this, "DisruptionFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.lambda_handler",
      code: lambda.Code.fromAsset(disruptionPackage),
      architecture: lambda.Architecture.X86_64,
      description: "Live accessibility disruption event service",
      environment: {
        EZPATH_STATUS_TABLE: statusTable.tableName,
      },
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: new logs.LogGroup(this, "DisruptionFunctionLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    statusTable.grantReadWriteData(disruptionFunction);

    const reportPackage = path.join(repositoryRoot, ".build", "report_lambda");
    const reportFunction = new lambda.Function(this, "ReportFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.lambda_handler",
      code: lambda.Code.fromAsset(reportPackage),
      architecture: lambda.Architecture.X86_64,
      description: "Community accessibility report intake and operator review",
      environment: {
        EZPATH_REPORTS_TABLE: reportsTable.tableName,
        EZPATH_REPORTS_BUCKET: reportBucket.bucketName,
      },
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: new logs.LogGroup(this, "ReportFunctionLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    reportsTable.grantReadWriteData(reportFunction);
    reportBucket.grantRead(reportFunction);
    reportBucket.grantPut(reportFunction);

    const publisherPackage = path.join(repositoryRoot, ".build", "event_publisher_lambda");
    const publisherFunction = new lambda.Function(this, "EventPublisherFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.lambda_handler",
      code: lambda.Code.fromAsset(publisherPackage),
      architecture: lambda.Architecture.X86_64,
      description: "Publish disruption-table changes to AppSync Events",
      environment: {
        EZPATH_APPSYNC_HTTP_DNS: eventsApi.httpDns,
        EZPATH_APPSYNC_CHANNEL: "/disruptions/network",
      },
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: new logs.LogGroup(this, "EventPublisherFunctionLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    disruptionNamespace.grantPublish(publisherFunction);

    const publisherDeadLetterQueue = new sqs.Queue(this, "EventPublisherDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    publisherFunction.addEventSource(
      new DynamoEventSource(statusTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 5,
        bisectBatchOnError: true,
        retryAttempts: 3,
        onFailure: new SqsDlq(publisherDeadLetterQueue),
      }),
    );

    const httpApi = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: "ezpath-routing-api",
      corsPreflight: {
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ["http://localhost:3000", ...(hostingUrl ? [hostingUrl] : [])],
        maxAge: Duration.hours(1),
      },
    });
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    defaultStage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
    const routeIntegration = new HttpLambdaIntegration("RouteIntegration", routeFunction);
    const disruptionIntegration = new HttpLambdaIntegration(
      "DisruptionIntegration",
      disruptionFunction,
    );
    const reportIntegration = new HttpLambdaIntegration("ReportIntegration", reportFunction);
    const operatorAuthorizer = new HttpJwtAuthorizer(
      "OperatorAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${operatorUserPool.userPoolId}`,
      { jwtAudience: [operatorClient.userPoolClientId] },
    );

    httpApi.addRoutes({
      path: "/health",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: routeIntegration,
    });
    httpApi.addRoutes({
      path: "/v1/reports/upload-request",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: reportIntegration,
    });
    httpApi.addRoutes({
      path: "/v1/reports",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: reportIntegration,
    });
    httpApi.addRoutes({
      path: "/v1/reports",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: reportIntegration,
      authorizer: operatorAuthorizer,
    });
    for (const action of ["verify", "reject"]) {
      httpApi.addRoutes({
        path: `/v1/reports/{reportId}/${action}`,
        methods: [apigatewayv2.HttpMethod.POST],
        integration: reportIntegration,
        authorizer: operatorAuthorizer,
      });
    }
    httpApi.addRoutes({
      path: "/v1/routes",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: routeIntegration,
    });
    httpApi.addRoutes({
      path: "/v1/journeys",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: routeIntegration,
    });
    httpApi.addRoutes({
      path: "/v1/events/active",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: disruptionIntegration,
    });
    httpApi.addRoutes({
      path: "/v1/telemetry/simulate",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: disruptionIntegration,
      authorizer: operatorAuthorizer,
    });
    httpApi.addRoutes({
      path: "/v1/telemetry/evidence",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: routeIntegration,
    });
    httpApi.addRoutes({
      path: "/v1/telemetry/confirm",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: disruptionIntegration,
      authorizer: operatorAuthorizer,
    });
    httpApi.addRoutes({
      path: "/v1/events",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: disruptionIntegration,
      authorizer: operatorAuthorizer,
    });
    httpApi.addRoutes({
      path: "/v1/events/{eventId}/resolve",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: disruptionIntegration,
      authorizer: operatorAuthorizer,
    });

    const dashboard = new cloudwatch.Dashboard(this, "RoutingDashboard", {
      dashboardName: "ezpath-routing",
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Routing Lambda p50/p95 duration",
        left: [
          routeFunction.metricDuration({ statistic: "p50" }),
          routeFunction.metricDuration({ statistic: "p95" }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Routing Lambda errors and throttles",
        left: [routeFunction.metricErrors(), routeFunction.metricThrottles()],
      }),
      new cloudwatch.GraphWidget({
        title: "Disruption Lambda invocations and errors",
        left: [disruptionFunction.metricInvocations(), disruptionFunction.metricErrors()],
      }),
      new cloudwatch.GraphWidget({
        title: "Event publisher invocations and errors",
        left: [publisherFunction.metricInvocations(), publisherFunction.metricErrors()],
      }),
      new cloudwatch.GraphWidget({
        title: "Community report Lambda invocations and errors",
        left: [reportFunction.metricInvocations(), reportFunction.metricErrors()],
      }),
    );

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "AwsRegion", { value: this.region });
    if (hostingApp && hostingBranch && hostingUrl) {
      new CfnOutput(this, "AmplifyAppId", { value: hostingApp.attrAppId });
      new CfnOutput(this, "AmplifyBranchName", { value: hostingBranch.attrBranchName });
      new CfnOutput(this, "AmplifyUrl", { value: hostingUrl });
    }
    new CfnOutput(this, "LocationMapName", { value: campusMap.mapName });
    new CfnOutput(this, "LocationSatelliteMapName", { value: satelliteMap.mapName });
    new CfnOutput(this, "LocationApiKeyName", { value: campusMapKey.keyName });
    new CfnOutput(this, "GraphBucketName", { value: graphBucket.bucketName });
    new CfnOutput(this, "GraphObjectKey", { value: "graphs/campus.graphml" });
    new CfnOutput(this, "TransitObjectKey", { value: "transit/chennai-transit.json.gz" });
    new CfnOutput(this, "StatusTableName", { value: statusTable.tableName });
    new CfnOutput(this, "ReportsTableName", { value: reportsTable.tableName });
    new CfnOutput(this, "ReportBucketName", { value: reportBucket.bucketName });
    new CfnOutput(this, "OperatorUserPoolId", { value: operatorUserPool.userPoolId });
    new CfnOutput(this, "OperatorUserPoolClientId", { value: operatorClient.userPoolClientId });
    new CfnOutput(this, "OperatorUserPoolDomain", { value: operatorDomain.baseUrl() });
    new CfnOutput(this, "AppSyncEventsHttpUrl", {
      value: `https://${eventsApi.httpDns}/event`,
    });
    new CfnOutput(this, "AppSyncEventsRealtimeUrl", {
      value: `wss://${eventsApi.realtimeDns}/event/realtime`,
    });
    new CfnOutput(this, "AppSyncEventsSubscriberKey", {
      value: eventsApi.apiKeys.SubscriberKey.attrApiKey,
    });
  }
}
