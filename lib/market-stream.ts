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
import * as locations from './locations.json';

export class MarketStream extends cdk.Construct {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id);
        const marketTable = new dynamodb.Table(this, 'MarketTable', {
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

        const marketConnectionHandler = new lambda.NodejsFunction(this, 'MarketConnectionHandler', {
            entry: 'lib/functions/market/connectionHandler/index.ts',
            timeout: cdk.Duration.seconds(60),
            awsSdkConnectionReuse: true
        });
        marketTable.grantReadWriteData(marketConnectionHandler);
        marketConnectionHandler.addEnvironment('TABLE_NAME', marketTable.tableName);

        let marketDataCollectors: lambda.NodejsFunction[] = [];
        Object.keys(locations).forEach((locationsToken) => {
            const locationSymbols = locations[locationsToken as keyof typeof locations]
            const tokenPrefix = locationsToken.substring(0,8);

            // for each entry in locations make new function throttld to one
            const marketDataCollector = new lambda.NodejsFunction(this, `MarketDataCollector${tokenPrefix}`, {
                entry: 'lib/functions/market/dataCollector/index.ts',
                timeout: cdk.Duration.minutes(5),
                reservedConcurrentExecutions: 1
            });
            marketTable.grantReadWriteData(marketDataCollector);
            marketDataCollector.addEnvironment('TABLE_NAME', marketTable.tableName);
            marketDataCollector.addEnvironment('LOCATIONS', JSON.stringify(locationSymbols));
            marketDataCollector.addEnvironment('TOKEN', locationsToken)


            // allow lambda to be invoked by schedule, and reinvoke by self with passing data payload
            const eventBus = events.EventBus;
            const rebootSelfIfEverythingGoesWrong = new events.Rule(this, `ScheduleRule${tokenPrefix}`, {
                schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
                targets: [new targets.LambdaFunction(marketDataCollector)],
                enabled: true
            });
            const receiveReinvokeEvents = new events.Rule(this, `ReinvokeRule${tokenPrefix}`, {
                eventPattern: {
                    source: [marketDataCollector.functionName],
                },
                targets: [new targets.LambdaFunction(marketDataCollector)],
                enabled: true
            })
            eventBus.grantAllPutEvents(marketDataCollector);

            marketDataCollectors.push(marketDataCollector);
        })


        const marketWebSocketApi = new apig.WebSocketApi(this, "MarketAPI", {
            description: "Market Data WebSocket API",
            connectRouteOptions: { integration: new integrations.LambdaWebSocketIntegration({ handler: marketConnectionHandler }) },
            disconnectRouteOptions: { integration: new integrations.LambdaWebSocketIntegration({ handler: marketConnectionHandler }) },
            defaultRouteOptions: { integration: new integrations.LambdaWebSocketIntegration({ handler: marketConnectionHandler }) },
        });

        marketDataCollectors.forEach((collector) => {
            collector.addToRolePolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: [`arn:aws:execute-api:*:*:${marketWebSocketApi.apiId}/*`],
                actions: [
                    'execute-api:ManageConnections'
                ]
            }))
        })
        marketConnectionHandler.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [`arn:aws:execute-api:*:*:${marketWebSocketApi.apiId}/*`],
            actions: [
                'execute-api:ManageConnections'
            ]
        }))


        let apiStageProps: apig.WebSocketStageProps = {
            webSocketApi: marketWebSocketApi,
            stageName: 'v1',
            autoDeploy: true,
        }
        let websocketStage: apig.WebSocketStage;

        if (process.env.HOSTED_ZONE_NAME && process.env.HOSTED_ZONE_ID && process.env.MARKET_SUBDOMAIN) {
            const fullyQualifiedDomainName = `${process.env.MARKET_SUBDOMAIN}.${process.env.HOSTED_ZONE_NAME}`;
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

            websocketStage = new apig.WebSocketStage(this, 'MarketAPIStageV1', apiStageProps);
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

            marketDataCollectors.forEach((collector) => {
                collector.addEnvironment('FULLY_QUALIFIED_DOMAIN_NAME', fullyQualifiedDomainName)
            })
            marketConnectionHandler.addEnvironment('FULLY_QUALIFIED_DOMAIN_NAME', fullyQualifiedDomainName)
        } else {
            websocketStage = new apig.WebSocketStage(this, 'MarketAPIStageV1', apiStageProps);

            marketDataCollectors.forEach((collector) => {
                collector.addEnvironment('API_ID', marketWebSocketApi.apiId);
                collector.addEnvironment('API_STAGE', websocketStage.stageName);
            })
        }
    }
}
