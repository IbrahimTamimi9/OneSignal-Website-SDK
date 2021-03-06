import '../../support/polyfills/polyfills';
import test, { GenericTestContext, Context as AvaContext } from 'ava';
import { ServiceWorker } from '../../../src/service-worker/ServiceWorker';
import { setUserAgent, setBrowser } from '../../support/tester/browser';
import { BrowserUserAgent, TestEnvironment, HttpHttpsEnvironment } from '../../support/sdk/TestEnvironment';

import Database from '../../../src/services/Database';
import { AppConfig, ConfigIntegrationKind } from '../../../src/models/AppConfig';
import { PushSubscriptionChangeEvent } from "../../support/mocks/service-workers/models/PushSubscriptionChangeEvent";
import PushSubscription from '../../support/mocks/service-workers/models/PushSubscription';
import ServiceWorkerGlobalScope from '../../support/mocks/service-workers/ServiceWorkerGlobalScope';
import PushManager from '../../support/mocks/service-workers/models/PushManager';
import { base64ToUint8Array } from "../../../src/utils/Encoding";
import Random from "../../support/tester/Random";
import nock from 'nock';
import sinon from 'sinon';
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager';
import { SubscriptionStateKind } from '../../../src/models/SubscriptionStateKind';

declare var self: ServiceWorkerGlobalScope;

test(`dispatching a mock pushsubscriptionchange event is received`, async t => {
  const appId = Random.getRandomUuid();
  await TestEnvironment.initializeForServiceWorker({
    url: new URL(`https://site.com/service-worker.js?appId=${appId}`)
  });

  const event = new PushSubscriptionChangeEvent();
  event.oldSubscription = null;
  event.newSubscription = null;

  self.addEventListener("pushsubscriptionchange", () => {
    t.pass();
  });
  self.dispatchEvent(event);
});

async function testCase(
  t: GenericTestContext<AvaContext<any>>,
  appId: string,
  /*
    We have an existing stored device ID, and this record is updated with the new push endpoint.
   */
  existingDeviceId: string,
  /*
    Used with existingDeviceId: null.

    The user partially cleared his browser data and IndexedDb, but we can "get back" the old ID by
    supplying the previous push endpoint.
   */
  idReturnedByLookupCall: string,
  oldSubscription: PushSubscription,
  newSubscription: PushSubscription,
  /*
    Used with newSubscription: null.

    This is what the custom/manual registration from the service worker will return when we try to
    resubscribe for a subscription.

    Set this to null in the event subscription isn't possible (e.g. permission is revoked to blocked).
   */
  newSubscriptionByReregistration: PushSubscription,
  onBeforePushSubscriptionChange: () => void,
) {
  let subscribeFcmFromWorkerStub;

  if (!newSubscription && !newSubscriptionByReregistration) {
    /*
      For this test, pretend the user revoked permissions, pushsubscriptionchange's event provides
      an oldSubscription but not a new subscription, and the service worker tries to resubscribe
      anyways.

      It's going to fail due to the blocked permission, so let's simulate that here.
     */
    subscribeFcmFromWorkerStub = sinon
      .stub(SubscriptionManager.prototype, 'subscribeFcmFromWorker')
      .throws('some-error');
  }

  nock('https://onesignal.com')
    .get(`/api/v1/sync/${appId}/web`)
    .reply(200, (uri, requestBody) => {
      return TestEnvironment.getFakeServerAppConfig(ConfigIntegrationKind.Custom)
    });

  if (existingDeviceId && existingDeviceId) {
    nock('https://onesignal.com')
      .post(`/api/v1/players/${existingDeviceId}/on_session`)
      .reply(200, (uri, requestBody) => {
        return {
          success: true
        }
      });
  } else {
    if (idReturnedByLookupCall) {
      // Service worker will make a POST call to look up ID
      nock('https://onesignal.com')
        .post(`/api/v1/players`)
        .reply(200, (uri, requestBody) => {
          t.is(
            JSON.parse(requestBody)["notification_types"],
            SubscriptionStateKind.TemporaryWebRecord
          );
          return {
            success: true,
            id: idReturnedByLookupCall
          }
        });

      // Service worker will make a POST call to register subscription
      nock('https://onesignal.com')
        .post(`/api/v1/players/${idReturnedByLookupCall}/on_session`)
        .reply(200, (uri, requestBody) => {
          return {
            success: true
          }
        });
    }
  }

  if (existingDeviceId && existingDeviceId) {
    const subscription = await Database.getSubscription();
    subscription.deviceId = existingDeviceId;
    subscription.subscriptionToken = oldSubscription.endpoint;
    await Database.setSubscription(subscription);
  }

  const event = new PushSubscriptionChangeEvent();
  event.oldSubscription = oldSubscription;
  event.newSubscription = newSubscription;

  const testPromise = new Promise(resolve => {
    self.addEventListener("pushsubscriptionchange", async event => {
      await ServiceWorker.onPushSubscriptionChange(event);
      resolve();
    });
  });

  await onBeforePushSubscriptionChange();
  self.dispatchEvent(event);
  await testPromise;

  if (!newSubscription && !newSubscriptionByReregistration) {
    subscribeFcmFromWorkerStub.restore();
  }
}

test(`called with an old and new subscription successfully updates the subscription`, async t => {
  const appId = Random.getRandomUuid();
  await TestEnvironment.initializeForServiceWorker({
    url: new URL(`https://site.com/service-worker.js?appId=${appId}`)
  });
  setBrowser(BrowserUserAgent.ChromeMacSupported);

  const existingDeviceId = Random.getRandomUuid();
  const oldSubscription = await new PushManager().subscribe({
    userVisibleOnly: true,
    applicationServerKey: Random.getRandomUint8Array(65).buffer
  });
  const newSubscription = await new PushManager().subscribe({
    userVisibleOnly: true,
    applicationServerKey: Random.getRandomUint8Array(65).buffer
  });

  await testCase(
    t,
    appId,
    existingDeviceId,
    null,
    oldSubscription,
    newSubscription,
    null,
    async () => {
      const subscription = await Database.getSubscription();
      t.deepEqual(subscription.deviceId, existingDeviceId);
      t.deepEqual(subscription.subscriptionToken, oldSubscription.endpoint);
    }
  );

  const subscription = await Database.getSubscription();

  // The device record ID should stay the same
  t.deepEqual(subscription.deviceId, existingDeviceId);
  // The subscription endpoint should be the new endpoint
  t.deepEqual(subscription.subscriptionToken, newSubscription.endpoint);
});

test(`without an existing device ID, lookup existing device ID, updates the looked-up record`, async t => {
  const appId = Random.getRandomUuid();
  await TestEnvironment.initializeForServiceWorker({
    url: new URL(`https://site.com/service-worker.js?appId=${appId}`)
  });
  setBrowser(BrowserUserAgent.ChromeMacSupported);

  const idReturnedByLookupCall = Random.getRandomUuid();
  const oldSubscription = await new PushManager().subscribe({
    userVisibleOnly: true,
    applicationServerKey: Random.getRandomUint8Array(65).buffer
  });
  const newSubscription = await new PushManager().subscribe({
    userVisibleOnly: true,
    applicationServerKey: Random.getRandomUint8Array(65).buffer
  });

  await testCase(
    t,
    appId,
    null,
    idReturnedByLookupCall,
    oldSubscription,
    newSubscription,
    null,
    async () => {
      const subscription = await Database.getSubscription();

      // There should be no existing device ID, we'll look this up by push endpoint in the test
      t.deepEqual(subscription.deviceId, null);
      // Don't check existence of old endpoint, it isn't used, pushsubscriptionchange provides the old endpoint
    }
  );

  const subscription = await Database.getSubscription();
  // We should now have a device ID
  t.deepEqual(subscription.deviceId, idReturnedByLookupCall);
  // Our push endpoint should be the new updated one
  t.deepEqual(subscription.subscriptionToken, newSubscription.endpoint);
});

test(
  `called with an old and without a new subscription, custom resubscription succeeds and updates record endpoint`,
  async t => {
    const appId = Random.getRandomUuid();
    await TestEnvironment.initializeForServiceWorker({
      url: new URL(`https://site.com/service-worker.js?appId=${appId}`)
    });
    setBrowser(BrowserUserAgent.ChromeMacSupported);

    const existingDeviceId = Random.getRandomUuid();
    // This subscription should persist for our mock PushManager
    const oldSubscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Random.getRandomUint8Array(65).buffer
    });
    const newSubscriptionByReregistration = await new PushManager().subscribe({
      userVisibleOnly: true,
      applicationServerKey: Random.getRandomUint8Array(65).buffer
    });

    const pushManagerSubscribe = sinon
      .stub(PushManager.prototype, 'subscribe')
      .callsFake(async options => {
        const subscription = await self.registration.pushManager.getSubscription();
        if (!subscription) {
          return newSubscriptionByReregistration;
        } else {
          return oldSubscription;
        }
      });

    await testCase(
      t,
      appId,
      existingDeviceId,
      null,
      oldSubscription,
      null,
      newSubscriptionByReregistration,
      async () => {
        const subscription = await Database.getSubscription();
        t.deepEqual(subscription.deviceId, existingDeviceId);
        t.deepEqual(subscription.subscriptionToken, oldSubscription.endpoint);
      }
    );

    const subscription = await Database.getSubscription();
    t.deepEqual(subscription.deviceId, existingDeviceId);
    t.deepEqual(subscription.subscriptionToken, newSubscriptionByReregistration.endpoint);

    pushManagerSubscribe.restore();
});

test(
  `called with an existing device ID, with old and without new subscription, custom resubscription fails ` +
  `and updates existing device record to clear subscription`,
  async t => {
    const appId = Random.getRandomUuid();
    await TestEnvironment.initializeForServiceWorker({
      url: new URL(`https://site.com/service-worker.js?appId=${appId}`)
    });
    setBrowser(BrowserUserAgent.ChromeMacSupported);

    const existingDeviceId = Random.getRandomUuid();
    const oldSubscription = await new PushManager().subscribe({
      userVisibleOnly: true,
      applicationServerKey: Random.getRandomUint8Array(65).buffer
    });

    await testCase(
      t,
      appId,
      existingDeviceId,
      null,
      oldSubscription,
      null,
      null,
      async () => {
        const subscription = await Database.getSubscription();
        t.deepEqual(subscription.deviceId, existingDeviceId);
        t.deepEqual(subscription.subscriptionToken, oldSubscription.endpoint);
      }
    );

    const subscription = await Database.getSubscription();
    t.deepEqual(subscription.deviceId, existingDeviceId);
    t.deepEqual(subscription.subscriptionToken, null);
});

test(
  `called without an existing device ID, without old and new subscription, custom resubscription fails ` +
  `and local data is cleared`,
  async t => {
    const appId = Random.getRandomUuid();
    await TestEnvironment.initializeForServiceWorker({
      url: new URL(`https://site.com/service-worker.js?appId=${appId}`)
    });
    setBrowser(BrowserUserAgent.ChromeMacSupported);

    await testCase(
      t,
      appId,
      null,
      null,
      null,
      null,
      null,
      async () => {
        const subscription = await Database.getSubscription();
        t.deepEqual(subscription.deviceId, null);
        t.deepEqual(subscription.subscriptionToken, null);
      }
    );

    const subscription = await Database.getSubscription();
    t.deepEqual(subscription.deviceId, null);
    t.deepEqual(subscription.subscriptionToken, null);
});
