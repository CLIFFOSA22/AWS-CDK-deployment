#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MyCdkProjectStack } from '../lib/aws-cdk-deployment-stack';

const app = new cdk.App();

new MyCdkProjectStack(app, 'AwsCdkDeploymentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});