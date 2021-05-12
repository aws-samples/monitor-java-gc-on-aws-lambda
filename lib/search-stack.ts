// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CfnIdentityPool, CfnIdentityPoolRoleAttachment, CfnUserPool, CfnUserPoolDomain } from '@aws-cdk/aws-cognito';
import { CfnDomain } from '@aws-cdk/aws-elasticsearch';
import { PolicyStatement, Effect } from '@aws-cdk/aws-iam';
import { FederatedPrincipal, ManagedPolicy, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { Function, Runtime, Code } from '@aws-cdk/aws-lambda';
import { CfnOutput, CfnParameter, Construct, CustomResource, Duration, Fn, Stack, StackProps } from '@aws-cdk/core';
import { Provider } from '@aws-cdk/custom-resources';

import path = require('path');
import fs = require('fs');

export class SearchStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {

    super(scope, id, props);

    const applicationPrefix = new CfnParameter(this, 'applicationPrefix', {
      default: this.node.tryGetContext('applicationPrefix'),
      description: "Prefix for the Amazon Cognito domain and the Amazon Elasticsearch Service domain",
      type: "String",
      allowedPattern: "^[a-z0-9]*$",
      minLength: 3,
      maxLength: 20
    }).valueAsString;

    const userPool = new CfnUserPool(this, "userPool", {
      adminCreateUserConfig: {
        allowAdminCreateUserOnly: true
      },
      usernameAttributes: ["email"],
      autoVerifiedAttributes: ["email"],
    });

    // get a unique suffix from the last element of the stackId, e.g. 06b321d6b6e2
    const suffix = Fn.select(4, Fn.split("-", Fn.select(2, Fn.split("/", this.stackId))));

    new CfnUserPoolDomain(this, "cognitoDomain", {
      domain: applicationPrefix + "-" + suffix,
      userPoolId: userPool.ref
    });

    const idPool = new CfnIdentityPool(this, "identityPool", {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: []
    });

    const authRole = new Role(this, "authRole", {
      assumedBy: new FederatedPrincipal('cognito-identity.amazonaws.com', {
        "StringEquals": { "cognito-identity.amazonaws.com:aud": idPool.ref },
        "ForAnyValue:StringLike": {
          "cognito-identity.amazonaws.com:amr": "authenticated"
        }
      }, "sts:AssumeRoleWithWebIdentity")
    });

    const esRole = new Role(this, "esRole", {
      assumedBy: new ServicePrincipal('es.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("AmazonESCognitoAccess")]
    });

    const esDomain = new CfnDomain(this, "searchDomain", {
      elasticsearchClusterConfig: { instanceType: "t3.small.elasticsearch" },
      ebsOptions: { volumeSize: 10, ebsEnabled: true },
      elasticsearchVersion: "7.10",
      domainName: applicationPrefix,
      nodeToNodeEncryptionOptions: { enabled: true },
      encryptionAtRestOptions: { enabled: true },
      domainEndpointOptions: {
        enforceHttps: true
      },
      cognitoOptions: {
        enabled: true,
        identityPoolId: idPool.ref,
        roleArn: esRole.roleArn,
        userPoolId: userPool.ref
      },

      // Trust the cognito authenticated Role
      accessPolicies: {
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Principal": {
              "AWS": authRole.roleArn
            },
            "Action": [
              "es:ESHttpGet",
              "es:ESHttpPut",
              "es:ESHttpPost",
              "es:ESHttpDelete"
            ],
            "Resource": "arn:aws:es:" + this.region + ":" + this.account + ":domain/" + applicationPrefix + "/*"
          }
        ]
      }
    });

    new CfnIdentityPoolRoleAttachment(this, 'userPoolRoleAttachment', {
      identityPoolId: idPool.ref,
      roles: {
        'authenticated': authRole.roleArn
      }
    });

    const ElasticsearchHttpPostPolicyStatement = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [`arn:${this.partition}:es:${this.region}:${this.account}:domain/${esDomain.domainName}/*`],
      actions: [
        "es:ESHttpPost",
        "es:ESHttpPut"
      ],
    });

    /**
     * Function implementing the requests to Amazon Elasticsearch Service
     * for the custom resource.
     */
    const esRequestsFn = new Function(this, 'esRequestsFn', {
      runtime: Runtime.NODEJS_14_X,
      handler: 'es-requests.handler',
      code: Code.fromAsset(path.join(__dirname, '..', 'functions/es-requests')),
      timeout: Duration.seconds(30),
      environment: {
        "DOMAIN": esDomain.attrDomainEndpoint,
        "REGION": this.region
      }
    });
    esRequestsFn.addToRolePolicy(ElasticsearchHttpPostPolicyStatement);

    const streamLogsFn = new Function(this, 'streamLogs', {
      runtime: Runtime.NODEJS_14_X,
      handler: 'stream-logs.handler',
      code: Code.fromAsset(path.join(__dirname, '..', 'functions/stream-logs')),
      environment: {
        "DOMAIN": esDomain.attrDomainEndpoint,
        "REGION": this.region
      },
    });
    streamLogsFn.addToRolePolicy(ElasticsearchHttpPostPolicyStatement);

    const esRequestProvider = new Provider(this, 'esRequestProvider', {
      onEventHandler: esRequestsFn
    });

    /**
     * You can import files exported via Kibana's
     * Stack Management -> Save Objects as done with the
     * dashboard.ndjson below.
     */
    new CustomResource(this, 'esRequestsResource', {
      serviceToken: esRequestProvider.serviceToken,
      properties: {
        requests: [
          {
            "method": "PUT",
            "path": "_template/example-index-template",
            "body": fs.readFileSync(path.join(__dirname, "index-template.json")).toString()
          },
          {
            "method": "POST",
            "path": "_plugin/kibana/api/saved_objects/_import?overwrite=true",
            "body": fs.readFileSync(path.join(__dirname, "dashboard.ndjson")).toString(),
            "filename": "dashboard.ndjson"
          },
        ]
      }
    });

    new CfnOutput(this, 'createUserUrl', {
      description: "Create a new user in the user pool here.",
      value: "https://" + this.region + ".console.aws.amazon.com/cognito/users?region=" + this.region + "#/pool/" + userPool.ref + "/users"
    });

    new CfnOutput(this, 'kibanaUrl', {
      description: "Access Kibana via this URL.",
      value: "https://" + esDomain.attrDomainEndpoint + "/_plugin/kibana/"
    });

  }
}
