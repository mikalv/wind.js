/**
 * Copyright (c) 2018-present, Code In Brackets
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Scheduler from "./scheduler";
import Actor from "./actor";
import drop from "./supervisor/drop";
import EventBus from "./event-bus";

const DoNothing = () => {};
const EmptyMaterializer = {
    onActivate: DoNothing,
    onDeactivate: DoNothing,
    onReceiveMessage: DoNothing,
    onBeforePullingMessage: DoNothing,
    onAfterMessageProcessed: DoNothing,
    onError: DoNothing,
    onSubscribe: DoNothing,
    onUnsubscribe: DoNothing
};

let composeMaterializers = (acc, current) => {
    acc = acc || {};
    current = current || {};

    let orDoNothing = (fn) => fn || DoNothing;
    let allMethods = [
        'onActivate',
        'onDeactivate',
        'onReceiveMessage',
        'onBeforePullingMessage',
        'onAfterMessageProcessed',
        'onError',
        'onSubscribe',
        'onUnsubscribe'
    ];

    let res = {};
    allMethods.forEach(method => {
        res[method] = function () {
            try {
                orDoNothing(acc[method]).apply(acc, arguments);
            } catch (e) {
                console.error("Error on materializer", method, e);
            }

            try {
                orDoNothing(current[method]).apply(acc, arguments);
            } catch (e) {
                console.error("Error on materializer", method, e);
            }
        }
    });

    return res;
};

/**
 * The Actor System is the class responsible of managing actors and their lifecycle.
 */
class ActorSystem {
    constructor({ schedulerInterval, supervisor, materializer, eventBus } = {}) {
        this.scheduler = new Scheduler(() => this.__pullAllActorMailboxes(), schedulerInterval || 0);
        this.supervisor = supervisor || (() => drop);

        if (Array.isArray(materializer)) {
            this.materializer = materializer.reduce(composeMaterializers, EmptyMaterializer);
        } else {
            this.materializer = composeMaterializers(EmptyMaterializer, materializer || {});
        }

        this.eventBus = eventBus || new EventBus();
        this.actors = {};
        this.hotActors = [];
        this.idleTimes = 0;
    }

    /**
     * Returns an Actor class that you can extend. You will need to implement yourself the onReceive method.
     *
     * @see Actor
     * @returns {class}
     * @constructor
     */
    get Actor() {
        let system = this;
        return class extends Actor {
            constructor(id, initialState) {
                super(id, initialState, { materializer: system.materializer, system: system });
                system.actors[this.id] = this;
            }
        }
    }

    /**
     * Gets an Actor instance by Id
     * @param id
     * @returns {Actor}
     */
    getActor(id) {
        return this.actors[id];
    }

    /**
     * Kills an actor and unregisters it from the Actor System. This actor will not receiver further messages,
     * but will eventually process the current mailbox.
     *
     * @param id
     */
    killActor(id) {
        let actor = this.actors[id];
        actor.kill();
        delete this.actors[id];
    }

    /**
     * Starts the ActorSystem, so it schedules messages. This is mandatory.
     */
    start() {
        this.scheduler.start();
    }

    /**
     * Stops gracefully the ActorSystem and all actors.
     * It will delay until all actors has been killed and all mailboxes processed.
     *
     * @returns {Promise<any>} Resolved when all actors has been killed.
     */
    stop() {
        Object.keys(this.actors).forEach(actorId => this.actors[actorId].kill());

        return new Promise(resolve => {
            this.scheduler.stop();

            let areAllIdle = () => Object.keys(this.actors).every(actorId =>
                this.actors[actorId].mailbox.isEmpty()
            );

            let nextStopTick = () => {
                if (!areAllIdle()) {
                    this.__pullAllActorMailboxes(true);
                    setTimeout(nextStopTick, 0);
                } else {
                    resolve();
                }
            };

            nextStopTick();
        });
    }

    /**
     * @private
     */
    requestTime(id) {
        this.idleTimes = 0;
        this.hotActors.push(id);
        this.scheduler.start();
    }

    /**
     * @private
     */
    __pullAllActorMailboxes(forceAll = false) {
        if (this.hotActors.length === 0 && !forceAll) {
            this.idleTimes++;
            if (this.idleTimes > 2) {
                this.scheduler.stop();
                return;
            }
        }

        let idsToPull = forceAll ? Object.keys(this.actors) : [ ...this.hotActors ];
        this.hotActors = [];

        idsToPull.forEach(async actorId => {
            await this.actors[actorId].pull().catch(error => this.supervisor(this, this.actors[actorId], error)(this, this.actors[actorId]));
        });
    }

    /**
     * Sends a message to an actor.
     *
     * @param id
     * @param message
     */
    tell(id, message) {
        this.getActor(id.id || id).receiveMessage({ origin: this, message });
    }

    /**
     * Asks for a message to an actor.
     *
     * @param id
     * @param message
     * @returns {Promise<any>}
     */
    ask(id, message) {
        return new Promise((resolve, reject) => {
            this.getActor(id.id || id).receiveMessage({ origin: this, message, answerTo: resolve, failOn: reject });
        });
    }
}

ActorSystem.Builder = () => {
    let builder = {
        withSchedulerInterval: (interval) => {
            builder.schedulerInterval = interval;
            return builder;
        },

        withSupervisor: (supervisor) => {
            builder.supervisor = supervisor;
            return builder;
        },

        withMaterializer: (materializer) => {
            builder.materializer = (builder.materializer || []).concat([materializer]);
            return builder;
        },

        withEventBus(eventBus) {
            builder.eventBus = eventBus;
            return builder;
        },

        build() {
            return new ActorSystem(builder);
        },
    };

    return builder;
};

ActorSystem.EmptyMaterializer = EmptyMaterializer;
ActorSystem.composeMaterializers = composeMaterializers;

export default ActorSystem;