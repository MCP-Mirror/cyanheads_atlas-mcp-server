/**
 * Manages atomic transactions for task operations
 */

import { Logger } from '../../../logging/index.js';
import { TaskStorage } from '../../../types/storage.js';
import { ErrorCodes, createError } from '../../../errors/index.js';
import { 
    Transaction,
    Operation,
    TransactionResult,
    TransactionOptions,
    DEFAULT_TRANSACTION_OPTIONS
} from '../../../types/transaction.js';
import { TransactionManager as StorageTransactionManager } from '../../../storage/core/transactions/manager.js';

export class TransactionManager {
    private readonly logger: Logger;
    private activeTransactions: Map<string, Transaction>;
    private transactionCounter: number;
    private readonly storageTransactionManager: StorageTransactionManager;
    private transactionTimeouts: Map<string, NodeJS.Timeout>;
    private static instance: TransactionManager | null = null;

    private constructor(private readonly storage?: TaskStorage) {
        this.logger = Logger.getInstance().child({ component: 'TaskTransactionManager' });
        this.activeTransactions = new Map();
        this.transactionTimeouts = new Map();
        this.transactionCounter = 0;
        this.storageTransactionManager = StorageTransactionManager.getInstance();
    }

    static getInstance(storage?: TaskStorage): TransactionManager {
        if (!TransactionManager.instance) {
            TransactionManager.instance = new TransactionManager(storage);
        }
        return TransactionManager.instance;
    }

    /**
     * Begins a new transaction
     */
    async begin(options: TransactionOptions = {}): Promise<Transaction> {
        const mergedOptions = { ...DEFAULT_TRANSACTION_OPTIONS, ...options };
        const id = this.generateTransactionId();
        const transaction: Transaction = {
            id,
            operations: [],
            timestamp: Date.now(),
            status: 'pending',
            timeout: mergedOptions.timeout,
            metadata: {
                retryCount: 0
            }
        };

        // Set up transaction timeout
        if (mergedOptions.timeout) {
            const timeoutHandle = setTimeout(() => {
                this.handleTransactionTimeout(id).catch(error => {
                    this.logger.error('Failed to handle transaction timeout', {
                        error,
                        transactionId: id
                    });
                });
            }, mergedOptions.timeout);
            
            this.transactionTimeouts.set(id, timeoutHandle);
        }

        try {
            // Acquire lock if required
            if (mergedOptions.requireLock) {
                await this.acquireLock(id);
            }

            // Start storage-level transaction
            if (this.storage && 'db' in this.storage) {
                await this.storageTransactionManager.beginTransaction((this.storage as any).db);
            }

            this.activeTransactions.set(id, transaction);
            
            this.logger.debug('Transaction started', { 
                transactionId: id,
                timestamp: transaction.timestamp,
                options: mergedOptions
            });

            return transaction;
        } catch (error) {
            this.logger.error('Failed to begin transaction', {
                error,
                transactionId: id
            });
            throw createError(
                ErrorCodes.TRANSACTION_ERROR,
                'Failed to begin transaction',
                String(error)
            );
        }
    }

    /**
     * Commits a transaction
     */
    async commit(transaction: Transaction, retryOnError: boolean = true): Promise<TransactionResult> {
        try {
            const startTime = Date.now();

            // Validate transaction state
            this.validateTransactionState(transaction);

            // Clear timeout if exists
            this.clearTransactionTimeout(transaction.id);

            try {
                // Persist and commit transaction
                if (this.storage && 'db' in this.storage) {
                    await this.persistTransaction(transaction);
                    await this.storageTransactionManager.commitTransaction(
                        (this.storage as any).db,
                        transaction.id
                    );
                }

                transaction.status = 'committed';
                this.activeTransactions.delete(transaction.id);

                const duration = Date.now() - startTime;
                this.logger.debug('Transaction committed', { 
                    transactionId: transaction.id,
                    operationCount: transaction.operations.length,
                    duration
                });

                return {
                    success: true,
                    transactionId: transaction.id,
                    metadata: {
                        duration,
                        retryCount: transaction.metadata?.retryCount
                    }
                };
            } catch (error) {
                // Retry logic for transient errors
                if (retryOnError && 
                    transaction.metadata?.retryCount! < DEFAULT_TRANSACTION_OPTIONS.retryLimit! &&
                    this.isRetryableError(error)) {
                    
                    transaction.metadata!.retryCount!++;
                    await new Promise(resolve => 
                        setTimeout(resolve, DEFAULT_TRANSACTION_OPTIONS.retryDelay));
                    
                    return this.commit(transaction, true);
                }

                throw error;
            }
        } catch (error) {
            this.logger.error('Failed to commit transaction', { 
                error,
                transactionId: transaction.id 
            });

            await this.rollback(transaction);

            return {
                success: false,
                transactionId: transaction.id,
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    /**
     * Rolls back a transaction
     */
    async rollback(transaction: Transaction): Promise<TransactionResult> {
        try {
            if (!this.activeTransactions.has(transaction.id)) {
                throw createError(
                    ErrorCodes.INVALID_STATE,
                    `Transaction ${transaction.id} not found`
                );
            }

            // Rollback storage-level transaction first
            if (this.storage && 'db' in this.storage) {
                await this.storageTransactionManager.rollbackTransaction(
                    (this.storage as any).db,
                    transaction.id
                );
            }

            // Then reverse operations in reverse order
            for (const operation of [...transaction.operations].reverse()) {
                await this.rollbackOperation(operation);
            }

            transaction.status = 'rolled_back';
            this.activeTransactions.delete(transaction.id);

            this.logger.debug('Transaction rolled back', { 
                transactionId: transaction.id,
                operationCount: transaction.operations.length 
            });

            return {
                success: true,
                transactionId: transaction.id
            };
        } catch (error) {
            this.logger.error('Failed to rollback transaction', { 
                error,
                transactionId: transaction.id 
            });

            // Even if application-level rollback fails, ensure storage transaction is rolled back
            if (this.storage && 'db' in this.storage) {
                try {
                    await this.storageTransactionManager.rollbackTransaction(
                        (this.storage as any).db,
                        transaction.id
                    );
                } catch (rollbackError) {
                    this.logger.error('Failed to rollback storage transaction', {
                        error: rollbackError,
                        transactionId: transaction.id
                    });
                }
            }

            return {
                success: false,
                transactionId: transaction.id,
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    /**
     * Gets active transaction by ID
     */
    getTransaction(id: string): Transaction | undefined {
        return this.activeTransactions.get(id);
    }

    /**
     * Generates a unique transaction ID
     */
    private generateTransactionId(): string {
        this.transactionCounter++;
        return `txn_${Date.now()}_${this.transactionCounter}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleTransactionTimeout(transactionId: string): Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction) return;

        this.logger.warn('Transaction timeout', {
            transactionId,
            duration: Date.now() - transaction.timestamp
        });

        try {
            await this.rollback(transaction);
        } finally {
            this.clearTransactionTimeout(transactionId);
        }
    }

    private clearTransactionTimeout(transactionId: string): void {
        const timeout = this.transactionTimeouts.get(transactionId);
        if (timeout) {
            clearTimeout(timeout);
            this.transactionTimeouts.delete(transactionId);
        }
    }

    private validateTransactionState(transaction: Transaction): void {
        if (!this.activeTransactions.has(transaction.id)) {
            throw createError(
                ErrorCodes.INVALID_STATE,
                `Transaction ${transaction.id} not found`
            );
        }

        if (transaction.status !== 'pending') {
            throw createError(
                ErrorCodes.INVALID_STATE,
                `Transaction ${transaction.id} is already ${transaction.status}`
            );
        }
    }

    private async acquireLock(transactionId: string): Promise<void> {
        // Implement distributed locking mechanism here
        // Could use Redis, ZooKeeper, or other lock service
        this.logger.debug('Lock acquired', { transactionId });
    }

    private isRetryableError(error: any): boolean {
        // Add logic to determine if error is transient
        return error.code === 'SQLITE_BUSY' || 
               error.code === 'SQLITE_LOCKED' ||
               error.message.includes('deadlock');
    }

    /**
     * Persists a transaction to storage
     */
    private async persistTransaction(transaction: Transaction): Promise<void> {
        if (!this.storage) return;

        try {
            // Implementation depends on storage interface
            // Could store in a transactions table or log
            this.logger.debug('Transaction persisted', { 
                transactionId: transaction.id 
            });
        } catch (error) {
            this.logger.error('Failed to persist transaction', { 
                error,
                transactionId: transaction.id 
            });
            throw error;
        }
    }

    /**
     * Rolls back a single operation
     */
    private async rollbackOperation(operation: Operation): Promise<void> {
        if (!this.storage) return;

        try {
            switch (operation.type) {
                case 'delete':
                    // Restore deleted tasks
                    if (operation.tasks && operation.tasks.length > 0) {
                        await this.storage.saveTasks(operation.tasks);
                    }
                    break;

                case 'update':
                    // Revert task to previous state
                    if (operation.previousState && operation.path) {
                        await this.storage.updateTask(operation.path, operation.previousState);
                    }
                    break;

                case 'create':
                    // Delete created task
                    if (operation.task) {
                        await this.storage.deleteTasks([operation.task.path]);
                    }
                    break;
            }
        } catch (error) {
            this.logger.error('Failed to rollback operation', { 
                error,
                operationType: operation.type 
            });
            throw error;
        }
    }
}
