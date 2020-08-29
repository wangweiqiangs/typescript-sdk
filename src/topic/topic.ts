import { PubPacketData } from '../models/packet-data';
import { AccessMode } from '../access-mode';
import { AppSettings, DEL_CHAR } from '../constants';
import { Packet } from '../models/packet';
import { CBuffer } from '../cbuffer';
import { Tinode } from '../tinode';
import { Subject } from 'rxjs';
import { Drafty } from '../drafty';
import { GetQuery } from '../models/get-query';
import { SetParams } from '../models/set-params';
import { normalizeArray } from '../utilities';
import { DelRange } from '../models/del-range';

export class Topic {
    /**
     * Topic created but not yet synced with the server. Used only during initialization.
     */
    private new = true;
    /**
     * User discovery tags
     */
    private tags = [];
    /**
     * Parent Tinode object
     */
    private tinode: Tinode;
    /**
     * Locally cached data
     * Subscribed users, for tracking read/recv/msg notifications.
     */
    private users: any = {};
    /**
     * Credentials such as email or phone number
     */
    private credentials = [];
    /**
     * Boolean, true if the topic is currently live
     */
    private subscribed = false;
    /**
     * Timestamp when the topic was created
     */
    private created: Date = null;
    /**
     * Timestamp when the topic was last updated
     */
    private update: Date = null;
    /**
     * Timestamp of the last messages
     */
    private touched: Date = null;
    /**
     * Indicator that the last request for earlier messages returned 0.
     */
    private noEarlierMsgs = false;
    /**
     * Access mode, see AccessMode
     */
    private acs = new AccessMode(null);
    /**
     * Current value of locally issued seqId, used for pending messages.
     */
    private queuedSeqId = AppSettings.LOCAL_SEQ_ID;
    /**
     * Message cache, sorted by message seq values, from old to new.
     */
    private messages = new CBuffer((a, b) => {
        return a.seq - b.seq;
    }, true);
    /**
     * The maximum known {data.seq} value.
     */
    maxSeq = 0;
    /**
     * The minimum known {data.seq} value.
     */
    minSeq = 0;
    /**
     * The maximum known deletion ID.
     */
    maxDel = 0;
    /**
     * Topic name
     */
    name: string;
    /**
     * Timestamp when topic meta-desc update was received.
     */
    lastDescUpdate: any;
    /**
     * Timestamp when topic meta-subs update was received.
     */
    lastSubsUpdate: any;
    /**
     * per-topic private data
     */
    private: any = null;
    /**
     * per-topic public data
     */
    public: any = null;

    // Topic events
    onData = new Subject<any>();
    onMeta = new Subject<any>();
    onPres = new Subject<any>();
    onInfo = new Subject<any>();
    onMetaSub = new Subject<any>(); // A single subscription record;
    onMetaDesc = new Subject<any>(); // A single desc update;
    onSubsUpdated = new Subject<any>(); // All subscription records received;
    onTagsUpdated = new Subject<any>();
    onCredsUpdated = new Subject<any>();
    onDeleteTopic = new Subject<any>();
    onAllMessagesReceived = new Subject<any>();

    constructor(name: string, tinode: Tinode) {
        this.name = name;
        this.tinode = tinode;
    }

    /**
     * Check if the topic is subscribed.
     */
    isSubscribed(): boolean {
        return this.subscribed;
    }

    /**
     * Create a draft of a message without sending it to the server.
     * @param data - Content to wrap in a draft.
     * @param noEcho - If true server will not echo message back to originating
     */
    createMessage(data: any, noEcho: boolean): Packet<PubPacketData> {
        return this.tinode.createMessage(this.name, data, noEcho);
    }

    /**
     * Update message's seqId.
     * @param pub - message packet.
     * @param newSeqId - new seq id for pub.
     */
    swapMessageId(pub: Packet<PubPacketData>, newSeqId: number) {
        const idx = this.messages.find({
            seq: pub.data.seq
        }, true);
        const numMessages = this.messages.length();
        pub.data.seq = newSeqId;
        if (0 <= idx && idx < numMessages) {
            // this.messages are sorted by `seq`.
            // If changing pub.seq to newSeqId breaks the invariant, fix it.
            // FIXME: Operator '<=' cannot be applied to types 'boolean' and 'number'.
            // if ((idx > 0 && this.messages.getAt(idx - 1).seq >= newSeqId) ||
            //     (idx + 1 < numMessages && newSeqId < this.messages.getAt(idx + 1).seq <= newSeqId)) {
            //     this.messages.delAt(idx);
            //     this.messages.put(pub);
            // }
        }
    }

    /**
     * Immediately publish data to topic. Wrapper for Tinode.publish
     * @param data - Data to publish, either plain string or a Drafty object.
     * @param noEcho - If <tt>true</tt> server will not echo message back to originating
     */
    publish(data: any, noEcho: boolean): Promise<any> {
        return this.publishMessage(this.createMessage(data, noEcho));
    }

    /**
     * Publish message created by create message
     * @param pub - {data} object to publish. Must be created by createMessage
     */
    async publishMessage(pub: Packet<PubPacketData>): Promise<any> {
        if (!this.subscribed) {
            return Promise.reject(new Error('Cannot publish on inactive topic'));
        }

        // Update header with attachment records.
        if (Drafty.hasAttachments(pub.data.content) && !pub.data.head.attachments) {
            const attachments = [];
            Drafty.attachments(pub.data.content, (data: any) => {
                attachments.push(data.ref);
            });
            pub.data.head.attachments = attachments;
        }

        pub.sending = true;
        pub.failed = false;

        try {
            const ctrl = await this.tinode.publishMessage(pub);
            pub.sending = false;
            pub.data.ts = ctrl.ts;
            this.swapMessageId(pub, ctrl.params.seq);
            this.routeData(pub);
            return ctrl;
        } catch (err) {
            this.tinode.logger('WARNING: Message rejected by the server', err);
            pub.sending = false;
            pub.failed = true;
            this.onData.next();
        }
    }

    /**
     * Add message to local message cache, send to the server when the promise is resolved.
     * If promise is null or undefined, the message will be sent immediately.
     * The message is sent when the
     * The message should be created by createMessage.
     * This is probably not the final API.
     * @param pub - Message to use as a draft.
     * @param prom - Message will be sent when this promise is resolved, discarded if rejected.
     */
    publishDraft(pub: Packet<PubPacketData>, prom?: Promise<any>): Promise<any> {
        if (!prom && !this.subscribed) {
            return Promise.reject(new Error('Cannot publish on inactive topic'));
        }

        const seq = pub.data.seq || this.getQueuedSeqId();
        if (!pub.noForwarding) {
            // The 'seq', 'ts', and 'from' are added to mimic {data}. They are removed later
            // before the message is sent.
            pub.noForwarding = true;
            pub.data.seq = seq;
            pub.data.ts = new Date();
            pub.data.from = this.tinode.getCurrentUserID();

            // Don't need an echo message because the message is added to local cache right away.
            pub.data.noecho = true;
            // Add to cache.
            this.messages.put(pub);
            this.onData.next(pub);
        }

        // If promise is provided, send the queued message when it's resolved.
        // If no promise is provided, create a resolved one and send immediately.
        prom = (prom || Promise.resolve()).then(
            () => {
                if (pub.cancelled) {
                    return {
                        code: 300,
                        text: 'cancelled'
                    };
                }

                return this.publishMessage(pub);
            },
            (err) => {
                this.tinode.logger('WARNING: Message draft rejected by the server', err);
                pub.sending = false;
                pub.failed = true;
                this.messages.delAt(this.messages.find(pub));
                this.onData.next();
            });
        return prom;
    }

    /**
     * Leave the topic, optionally unsubscribe. Leaving the topic means the topic will stop
     * receiving updates from the server. Unsubscribing will terminate user's relationship with the topic.
     * Wrapper for Tinode.leave
     * @param unsub - If true, unsubscribe, otherwise just leave.
     */
    async leave(unsub: boolean) {
        // It's possible to unsubscribe (unsub==true) from inactive topic.
        if (!this.subscribed && !unsub) {
            return Promise.reject(new Error('Cannot leave inactive topic'));
        }

        // Send a 'leave' message, handle async response
        const ctrl = await this.tinode.leave(this.name, unsub);
        this.resetSub();
        if (unsub) {
            this.gone();
        }
        return ctrl;
    }

    /**
     * Request topic metadata from the server.
     * @param params - parameters
     */
    getMeta(params: GetQuery) {
        // Send {get} message, return promise.
        return this.tinode.getMeta(this.name, params);
    }

    /**
     * Request more messages from the server
     * @param limit - number of messages to get.
     * @param forward - if true, request newer messages.
     */
    getMessagesPage(limit: number, forward: boolean) {
        const query = this.startMetaQuery();
        if (forward) {
            query.withLaterData(limit);
        } else {
            query.withEarlierData(limit);
        }
        let promise = this.getMeta(query.build());
        if (!forward) {
            promise = promise.then((ctrl) => {
                if (ctrl && ctrl.params && !ctrl.params.count) {
                    this.noEarlierMsgs = true;
                }
            });
        }
        return promise;
    }

    /**
     * Update topic metadata.
     * @param params - parameters to update.
     */
    async setMeta(params: SetParams) {
        if (params.tags) {
            params.tags = normalizeArray(params.tags);
        }
        // Send Set message, handle async response.
        const ctrl = await this.tinode.setMeta(this.name, params)
        if (ctrl && ctrl.code >= 300) {
            // Not modified
            return ctrl;
        }

        if (params.sub) {
            params.sub.topic = this.name;
            if (ctrl.params && ctrl.params.acs) {
                params.sub.acs = ctrl.params.acs;
                params.sub.updated = ctrl.ts;
            }
            if (!params.sub.user) {
                // This is a subscription update of the current user.
                // Assign user ID otherwise the update will be ignored by _processMetaSub.
                params.sub.user = this.tinode.getCurrentUserID();
                if (!params.desc) {
                    // Force update to topic's asc.
                    params.desc = {} as any;
                }
            }
            params.sub.noForwarding = true;
            this.processMetaSub([params.sub]);
        }

        if (params.desc) {
            if (ctrl.params && ctrl.params.acs) {
                params.desc.acs = ctrl.params.acs;
                params.desc.updated = ctrl.ts;
            }
            this.processMetaDesc(params.desc);
        }

        if (params.tags) {
            this.processMetaTags(params.tags);
        }
        if (params.cred) {
            this.processMetaCreds([params.cred], true);
        }

        return ctrl;
    }

    /**
     * Update access mode of the current user or of another topic subsriber.
     * @param uid - UID of the user to update or null to update current user.
     * @param update - the update value, full or delta.
     */
    updateMode(uid: string, update: string) {
        const user = uid ? this.subscriber(uid) : null;
        const am = user ?
            user.acs.updateGiven(update).getGiven() :
            this.getAccessMode().updateWant(update).getWant();

        return this.setMeta({
            sub: {
                user: uid,
                mode: am
            }
        });
    }

    /**
     * Create new topic subscription. Wrapper for Tinode.setMeta.
     * @param userId - ID of the user to invite
     * @param mode - Access mode. <tt>null</tt> means to use default.
     */
    invite(userId: string, mode: string): Promise<any> {
        return this.setMeta({
            sub: {
                user: userId,
                mode,
            }
        });
    }

    /**
     * Archive or un-archive the topic. Wrapper for Tinode.setMeta.
     * @param arch - true to archive the topic, false otherwise
     */
    archive(arch: boolean) {
        if (this.private && this.private.arch === arch) {
            return Promise.resolve(arch);
        }
        return this.setMeta({
            desc: {
                private: {
                    arch: arch ? true : DEL_CHAR
                }
            }
        });
    }

    /**
     * Delete messages. Hard-deleting messages requires Owner permission.
     * @param ranges - Ranges of message IDs to delete.
     * @param hard - Hard or soft delete
     */
    delMessages(ranges: DelRange[], hard?: boolean) {
        if (!this.subscribed) {
            return Promise.reject(new Error('Cannot delete messages in inactive topic'));
        }

        // Sort ranges in ascending order by low, the descending by hi.
        ranges.sort((r1, r2) => {
            if (r1.low < r2.low) {
                return 1;
            }
            if (r1.low === r2.low) {
                return !r2.hi || (r1.hi >= r2.hi) === true ? 1 : -1;
            }
            return -1;
        });

        // Remove pending messages from ranges possibly clipping some ranges.
        const tosend = ranges.reduce((out, r) => {
            if (r.low < AppSettings.LOCAL_SEQ_ID) {
                if (!r.hi || r.hi < AppSettings.LOCAL_SEQ_ID) {
                    out.push(r);
                } else {
                    // Clip hi to max allowed value.
                    out.push({
                        low: r.low,
                        hi: this.maxSeq + 1
                    });
                }
            }
            return out;
        }, []);

        // Send {del} message, return promise
        let result;
        if (tosend.length > 0) {
            result = this.tinode.delMessages(this.name, tosend, hard);
        } else {
            result = Promise.resolve({
                params: {
                    del: 0
                }
            });
        }

        return result.then((ctrl) => {
            if (ctrl.params.del > this.maxDel) {
                this.maxDel = ctrl.params.del;
            }

            ranges.forEach((r) => {
                if (r.hi) {
                    this.flushMessageRange(r.low, r.hi);
                } else {
                    this.flushMessage(r.low);
                }
            });

            this.updateDeletedRanges();
            // Calling with no parameters to indicate the messages were deleted.
            this.onData.next();
            return ctrl;
        });
    }

    /**
     *  Delete all messages. Hard-deleting messages requires Owner permission.
     * @param hard - true if messages should be hard-deleted.
     */
    delMessagesAll(hard?: boolean) {
        if (!this.maxSeq || this.maxSeq <= 0) {
            // There are no messages to delete.
            return Promise.resolve();
        }
        return this.delMessages([{
            low: 1,
            hi: this.maxSeq + 1,
            all: true
        }], hard);
    }

    /**
     * Delete multiple messages defined by their IDs. Hard-deleting messages requires Owner permission.
     * @param list - list of seq IDs to delete
     * @param hard - true if messages should be hard-deleted.
     */
    delMessagesList(list: DelRange[], hard?: boolean) {
        // Sort the list in ascending order
        // FIXME: Can not sort this array like this
        // list.sort((a, b) => a - b);


        // Convert the array of IDs to ranges.
        const ranges = list.reduce((out, id) => {
            if (out.length === 0) {
                // First element.
                out.push({
                    low: id
                });
            } else {
                const prev = out[out.length - 1];
                if ((!prev.hi && (id !== prev.low + 1)) || (id > prev.hi)) {
                    // New range.
                    out.push({
                        low: id
                    });
                } else {
                    // Expand existing range.
                    // FIXME: Operator '+' cannot be applied to types 'DelRange' and 'number'.
                    // prev.hi = prev.hi ? Math.max(prev.hi, id + 1) : id + 1;
                }
            }
            return out;
        }, []);

        // Send {del} message, return promise
        return this.delMessages(ranges, hard);
    }

    /**
     *  Delete topic. Requires Owner permission. Wrapper for delTopic
     * @param hard - had-delete topic.
     */
    async delTopic(hard?: boolean): Promise<any> {
        const ctrl = await this.tinode.delTopic(this.name, hard);
        this.resetSub();
        this.gone();
        return ctrl;
    }

    /**
     * Delete subscription. Requires Share permission. Wrapper for Tinode.delSubscription
     * @param user - ID of the user to remove subscription for.
     */
    async delSubscription(user: string): Promise<any> {
        if (!this.subscribed) {
            return Promise.reject(new Error('Cannot delete subscription in inactive topic'));
        }

        // Send {del} message, return promise
        const ctrl = await this.tinode.delSubscription(this.name, user);
        // Remove the object from the subscription cache;
        delete this.users[user];
        // Notify listeners
        this.onSubsUpdated.next(Object.keys(this.users));
        return ctrl;
    }

    /**
     * Send a read/recv notification
     * @param what - what notification to send: <tt>recv</tt>, <tt>read</tt>.
     * @param seq - ID or the message read or received.
     */
    note(what: string, seq: number) {
        const user = this.users[this.tinode.getCurrentUserID()];
        if (user) {
            if (!user[what] || user[what] < seq) {
                if (this.subscribed) {
                    this.tinode.note(this.name, what, seq);
                } else {
                    this.tinode.logger('INFO: Not sending {note} on inactive topic');
                }

                user[what] = seq;
            }
        } else {
            this.tinode.logger('ERROR: note(): user not found ' + this.tinode.getCurrentUserID());
        }

        // Update locally cached contact with the new count
        const me = this.tinode.getMeTopic();
        if (me) {
            me.setMsgReadRecv(this.name, what, seq);
        }
    }

    /**
     * Send a 'recv' receipt. Wrapper for Tinode.noteRecv.
     * @param seq - ID of the message to acknowledge.
     */
    noteRecv(seq: number) {
        this.note('recv', seq);
    }

    /**
     * Send a 'read' receipt. Wrapper for Tinode.noteRead.
     * @param seq - ID of the message to acknowledge or 0/undefined to acknowledge the latest messages.
     */
    noteRead(seq: number) {
        seq = seq || this.maxSeq;
        if (seq > 0) {
            this.note('read', seq);
        }
    }

    /**
     * Send a key-press notification. Wrapper for Tinode.noteKeyPress.
     */
    noteKeyPress() {
        if (this.subscribed) {
            this.tinode.noteKeyPress(this.name);
        } else {
            this.tinode.logger('INFO: Cannot send notification in inactive topic');
        }
    }

    /**
     * Get user description from global cache. The user does not need to be a
     * subscriber of this topic.
     * @param uid - ID of the user to fetch.
     */
    userDesc(uid: string) {
        // TODO(gene): handle asynchronous requests
        const user = this.cacheGetUser(uid);
        if (user) {
            return user; // Promise.resolve(user)
        }
    }

    /**
     * Get description of the p2p peer from subscription cache.
     */
    p2pPeerDesc() {
        if (this.getType() !== 'p2p') {
            return undefined;
        }
        return this.users[this.name];
    }

    /**
     * Iterate over cached subscribers. If callback is undefined, use this.onMetaSub.
     * @param callback - Callback which will receive subscribers one by one.
     * @param context - Value of `this` inside the `callback`.
     */
    subscribers(callback, context) {
        const cb = (callback || this.onMetaSub);
        if (cb) {
            for (let idx in this.users) {
                if (idx) {
                    cb.call(context, this.users[idx], idx, this.users);
                }
            }
        }
    }

    /**
     * Get a copy of cached tags.
     */
    getTags() {
        // Return a copy.
        return this.tags.slice(0);
    }

    /**
     * Get cached subscription for the given user ID.
     * @param uid - id of the user to query for
     */
    subscriber(uid: string) {
        return this.users[uid];
    }

    cacheGetUser(a): any { }
    flushMessage(a: any) { }
    updateDeletedRanges() { }
    flushMessageRange(a: any, b: any) { }
    getAccessMode(): any { }
    processMetaCreds(a: any, b: any) { }
    processMetaTags(a: any) { }
    processMetaSub(a: any) { }
    processMetaDesc(a: any) { }
    startMetaQuery(): any { }
    resetSub() { }

    gone() { }

    getType(): string {
        return '';
    }

    subscribe() { }

    getQueuedSeqId() {
        return 0;
    }

    routeData(a: Packet<PubPacketData>) { }
}
