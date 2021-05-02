import * as cdk from '@aws-cdk/core';
import { FlightPlansStream } from './flight-plans-stream';
import { MarketStream } from './market-stream';

export class DataStreamsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const flightPlansStream = new FlightPlansStream(this, 'FlightPlansStream');
    const marketStream = new MarketStream(this, 'MarketStream');
  }
}
