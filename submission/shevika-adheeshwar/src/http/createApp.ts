import express, { type ErrorRequestHandler, type Express } from 'express';

import { DomainError } from '../domain/errors';
import { PlanCatalog } from '../domain/PlanCatalog';
import { TransitionTable } from '../domain/TransitionTable';
import type { PaymentProvider } from '../payments/PaymentProvider';
import type { Database } from '../persistence/Database';
import {
  AuditLogRepository,
  CustomerRepository,
  InvoiceRepository,
  PaymentRepository,
  SubscriptionRepository,
} from '../persistence/repositories';
import { BillingService } from '../services/BillingService';
import { SubscriptionLifecycle } from '../services/SubscriptionLifecycle';
import { SubscriptionService } from '../services/SubscriptionService';
import { systemClock, type Clock } from '../support/clock';

import { toSubscriptionResource } from './resources';

export interface AppDependencies {
  readonly database: Database;
  /** The seam: tests pass a recording double, production would pass a real client. */
  readonly paymentProvider: PaymentProvider;
  readonly clock?: Clock;
}

/**
 * The composition root.
 *
 * This is the single place where concrete implementations are chosen and wired
 * together, which is what makes the payment provider substitutable without any
 * module patching: a test simply builds the app with a different one. Nothing
 * below this function constructs its own dependencies.
 */
export function createApp(dependencies: AppDependencies): Express {
  const { database, paymentProvider } = dependencies;
  const clock = dependencies.clock ?? systemClock;

  const plans = new PlanCatalog();
  const customers = new CustomerRepository(database);
  const subscriptions = new SubscriptionRepository(database);
  const invoices = new InvoiceRepository(database);
  const payments = new PaymentRepository(database);
  const audit = new AuditLogRepository(database);

  const lifecycle = new SubscriptionLifecycle(new TransitionTable(), subscriptions, audit, clock);

  const billing = new BillingService({
    subscriptions,
    invoices,
    payments,
    lifecycle,
    paymentProvider,
    clock,
  });

  const subscriptionService = new SubscriptionService({
    plans,
    customers,
    subscriptions,
    invoices,
    audit,
    lifecycle,
    billing,
    clock,
  });

  const app = express();
  app.use(express.json());

  app.post('/subscriptions', (req, res, next) => {
    subscriptionService
      .create(req.body ?? {})
      .then((subscription) => res.status(201).json(toSubscriptionResource(subscription)))
      .catch(next);
  });

  app.post('/subscriptions/:id/cancel', (req, res, next) => {
    try {
      res.status(200).json(toSubscriptionResource(subscriptionService.cancel(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/subscriptions/:id/bill', (req, res, next) => {
    subscriptionService
      .bill(req.params.id)
      .then((subscription) => res.status(200).json(toSubscriptionResource(subscription)))
      .catch(next);
  });

  app.get('/subscriptions/:id', (req, res, next) => {
    try {
      res.status(200).json(toSubscriptionResource(subscriptionService.findById(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof DomainError) {
      res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({
      error: { code: 'internal_error', message: error instanceof Error ? error.message : 'unknown' },
    });
  };
  app.use(handleError);

  return app;
}
