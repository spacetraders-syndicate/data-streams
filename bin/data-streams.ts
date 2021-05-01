#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
require('dotenv').config()

import { DataStreamsStack } from '../lib/data-streams-stack';

const app = new cdk.App();

const stackName = process.env.STACK_NAME ? process.env.STACK_NAME : 'DataStreamsStack';
new DataStreamsStack(app, stackName, {});
