import * as cdk from '@aws-cdk/core';
import * as apig from '@aws-cdk/aws-apigatewayv2';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as integrations from '@aws-cdk/aws-apigatewayv2-integrations';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as certificateManager from '@aws-cdk/aws-certificatemanager';
import * as route53 from '@aws-cdk/aws-route53';
import * as route53Targets from '@aws-cdk/aws-route53-targets';
import * as targets from '@aws-cdk/aws-events-targets';
import * as events from '@aws-cdk/aws-events';
import * as iam from "@aws-cdk/aws-iam";

export class FlightPlansStream extends cdk.Construct {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id);
        const flightPlansTable = new dynamodb.Table(this, 'FlightPlansTable', {
            partitionKey: {
                name: 'pk',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'sk',
                type: dynamodb.AttributeType.STRING
            },
            encryption: dynamodb.TableEncryption.AWS_MANAGED
        })

        const flightPlansConnectionHandler = new lambda.NodejsFunction(this, 'FlightPlansConnectionHandler', {
            entry: 'lib/functions/flightPlans/connectionHandler/index.ts',
            timeout: cdk.Duration.seconds(10),
            awsSdkConnectionReuse: true
        });
        flightPlansTable.grantReadWriteData(flightPlansConnectionHandler);
        flightPlansConnectionHandler.addEnvironment('TABLE_NAME', flightPlansTable.tableName);


        const flightPlansDataCollector = new lambda.NodejsFunction(this, 'FlightPlansDataCollector', {
            entry: 'lib/functions/flightPlans/dataCollector/index.ts',
            timeout: cdk.Duration.minutes(15),
            reservedConcurrentExecutions: 1
        });
        flightPlansTable.grantReadWriteData(flightPlansDataCollector);
        flightPlansDataCollector.addEnvironment('TABLE_NAME', flightPlansTable.tableName);

        
        // allow lambda to be invoked by schedule, and reinvoke by self with passing data payload
        const eventBus = events.EventBus;
        const rebootSelfIfEverythingGoesWrong = new events.Rule(this, 'ScheduleRule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
            targets: [new targets.LambdaFunction(flightPlansDataCollector)],
            enabled: true
        });
        const receiveReinvokeEvents = new events.Rule(this, 'ReinvokeRule', {
            eventPattern: {
                source: [flightPlansDataCollector.functionName],
            },
            targets: [new targets.LambdaFunction(flightPlansDataCollector)],
            enabled: true
        })
        eventBus.grantAllPutEvents(flightPlansDataCollector);

        const flightPlansWebSocketApi = new apig.WebSocketApi(this, "FlightPlansAPI", {
            description: "Flight Plans Data WebSocket API",
            connectRouteOptions: { integration: new integrations.LambdaWebSocketIntegration({ handler: flightPlansConnectionHandler }) },
            disconnectRouteOptions: { integration: new integrations.LambdaWebSocketIntegration({ handler: flightPlansConnectionHandler }) },
            defaultRouteOptions: { integration: new integrations.LambdaWebSocketIntegration({ handler: flightPlansConnectionHandler }) },
        });
        flightPlansDataCollector.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [`arn:aws:execute-api:*:*:${flightPlansWebSocketApi.apiId}/*`],
            actions: [
                'execute-api:ManageConnections'
            ]
        }))


        let apiStageProps: apig.WebSocketStageProps = {
            webSocketApi: flightPlansWebSocketApi,
            stageName: 'v1',
            autoDeploy: true,
        }
        let websocketStage;

        if (process.env.HOSTED_ZONE_NAME && process.env.HOSTED_ZONE_ID && process.env.FLIGHTPLANS_SUBDOMAIN) {
            const fullyQualifiedDomainName = `${process.env.FLIGHTPLANS_SUBDOMAIN}.${process.env.HOSTED_ZONE_NAME}`;
            const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'MyZone', {
                zoneName: process.env.HOSTED_ZONE_NAME,
                hostedZoneId: process.env.HOSTED_ZONE_ID,
            });
            const certificate = new certificateManager.DnsValidatedCertificate(this, "Certificate", {
                domainName: fullyQualifiedDomainName,
                hostedZone
            })
            const domainName = new apig.DomainName(this, "CustomDomainName", {
                domainName: fullyQualifiedDomainName,
                certificate
            })

            apiStageProps = {
                ...apiStageProps,
                domainMapping: {
                    domainName: domainName
                }
            }

            websocketStage = new apig.WebSocketStage(this, 'FlightPlansAPIStageV1', apiStageProps);
            const route53Record = new route53.ARecord(this, 'AliasRecord', {
                zone: hostedZone,
                recordName: fullyQualifiedDomainName,
                target: route53.RecordTarget.fromAlias(
                    new route53Targets.ApiGatewayv2DomainProperties(
                        domainName.regionalDomainName,
                        domainName.regionalHostedZoneId
                    )
                )
            })
            flightPlansDataCollector.addEnvironment('FULLY_QUALIFIED_DOMAIN_NAME', fullyQualifiedDomainName)
        } else {
            websocketStage = new apig.WebSocketStage(this, 'FlightPlansAPIStageV1', apiStageProps);
            flightPlansDataCollector.addEnvironment('API_ID', flightPlansWebSocketApi.apiId);
            flightPlansDataCollector.addEnvironment('API_STAGE', websocketStage.stageName);
        }



    }
}
