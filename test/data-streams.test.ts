import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as DataStreams from '../lib/data-streams-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new DataStreams.DataStreamsStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
