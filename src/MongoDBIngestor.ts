import { extractDate } from "@treecg/ldes-snapshot";
import { MongoFragment } from "@treecg/sds-storage-writer-mongo/lib/fragmentHelper";
import { Member, RelationType, SDS } from '@treecg/types';
import { Collection, Db, Document, WithId, MongoClient } from "mongodb";
import { Store } from 'n3';
import { AbstractIngestor, IngestorConfig, IRelation, TSIngestor } from './AbstractIngestor';
import { quadsToString } from './Util';
import { Window } from "./AbstractIngestor";

export interface MongoDBIngestorConfig extends IngestorConfig {
    /**
     * The name of the MongoDB Collection for the SDS metadata information.
     */
    metaCollectionName?: string

    /**
     * The name of the MongoDB Collection for the members.
     */
    dataCollectionName?: string;

    /**
     * The name of the MongoDB Collection for the relations (the buckets/fragments).
     */
    indexCollectionName?: string;


    /**
     * The URL of the MongoDB database.
     */
    mongoDBURL?: string;

}

export class MongoDBIngestor extends AbstractIngestor {
    private metaCollectionName: string;
    private dataCollectionName: string;
    private indexCollectionName: string;
    private mongoDBURL: string;

    private mongoConnection: MongoClient | undefined;
    private _db: Db | undefined;

    public constructor(config: MongoDBIngestorConfig) {
        super(config);
        this.mongoDBURL = config.mongoDBURL ?? "mongodb://localhost:27017/ldes";
        this.metaCollectionName = config.metaCollectionName ?? "meta";
        this.dataCollectionName = config.dataCollectionName ?? "data";
        this.indexCollectionName = config.indexCollectionName ?? "index";
    }

    protected get dbDataCollection(): Collection<Document> {
        if (!this.mongoConnection) {
            throw Error(`Not connected to ${this.mongoDBURL} while trying to use to the data Collection. Try \`initialise\` first.`);
        }
        return this.db.collection(this.dataCollectionName);
    }

    protected get dbIndexCollection(): Collection<Document> {
        if (!this.mongoConnection) {
            throw Error(`Not connected to ${this.mongoDBURL} while trying to use to the index Collection. Try \`initialise\` first.`);
        }
        return this.db.collection(this.indexCollectionName);
    }

    protected get dbMetaCollection(): Collection<Document> {
        if (!this.mongoConnection) {
            throw Error(`Not connected to ${this.mongoDBURL} while trying to use to the meta Collection. Try \`initialise\` first.`);
        }
        return this.db.collection(this.metaCollectionName);
    }

    protected get db(): Db {
        if (!this.mongoConnection) {
            throw Error(`Not connected to ${this.mongoDBURL}. Try \`initialise\` first.`);
        }
        return this._db!;
    }
    /**
     * Stores the metadata of the SDS stream into the Mongo Database in the meta collection.
     *
     * @param sdsMetadata - The SDS metadata for the SDS Stream.
     */
    public async initialise(sdsMetadata?: string): Promise<void> {
        this.mongoConnection = await new MongoClient(this.mongoDBURL).connect();
        this._db = this.mongoConnection.db();

        const streamExists = await this.dbMetaCollection.findOne({ id: this.sdsStreamIdentifier });

        if (streamExists) return // log that a stream already exists so must not be initialised

        if (!sdsMetadata) throw Error("No way to create SDS metadata, can be done later maybe.")

        await this.dbMetaCollection.insertOne({ id: this.sdsStreamIdentifier, value: sdsMetadata, type: SDS.Stream }, {});
    }

    public async exit(): Promise<void> {
        await this.mongoConnection?.close();
    }

    /**
     * Stores members into the Mongo Database in the data collection.
     *
     * @param member
     * @param timestamp
     */
    public async storeMembers(member: Member[]): Promise<void> {
        const dataElements: { id: string, data: string, timestamp?: string }[] = []
        // todo: extract timestamp from data later by using the ldes:timestampPath from the sds:description
        member.forEach(member => {
            const id = member.id.value;
            const data = quadsToString(member.quads);

            dataElements.push({ id, data });
        })

        await this.dbDataCollection.insertMany(dataElements);
    }
    /**
     * Stores a bucket into the Mongo Database in the index collection.
     *
     * @param member
     * @param timestamp
     */
    public async createBucket(bucketIdentifier: string): Promise<void> {
        const bucket: MongoFragment = {
            id: bucketIdentifier,
            streamId: this.sdsStreamIdentifier,
            leaf: true,
            relations: [],
            count: 0,
            members: []
        }
        await this.dbIndexCollection.insertOne(bucket);
    }

    public async addMemberstoBucket(bucketIdentifier: string, memberIDs: string[]): Promise<void> {
        await this.dbIndexCollection.updateOne({ id: bucketIdentifier, streamId: this.sdsStreamIdentifier }, { "$push": { members: { "$each": memberIDs } } });
    }
    public async addRelationsToBucket(bucketIdentifier: string, relations: IRelation[]): Promise<void> {
        // TODO: handle bucket in relation not existing
        // TODO: handle bucket itself not existing
        await this.dbIndexCollection.updateOne({ id: bucketIdentifier, streamId: this.sdsStreamIdentifier }, { "$push": { relations: { "$each": relations } } });
    }

    protected async bucketExists(bucketIdentifier: string): Promise<boolean> {
        const exists = await this.dbIndexCollection.findOne({ streamId: this.sdsStreamIdentifier, id: bucketIdentifier });
        if (exists) {
            return true
        }
        return false
    }
}

export class TSMongoDBIngestor extends MongoDBIngestor implements TSIngestor {
    protected _pageSize?: number;
    protected _timestampPath?: string;
    protected _metadata?: any; // TODO: ldes and sds metadata?
    protected root = "";


    private get pageSize(): number {
        return this._pageSize ?? Infinity;
    }

    private get timestampPath(): string {
        if (!this._timestampPath) throw Error("TimestampPath was not configured");
        return this._timestampPath;
    }

    // initializes a LDES-TS if it does not exist yet.
    // Otherwise, just starts up the database
    async instantiate(config: string): Promise<void> {
        await this.initialise(config)

        // extract metadata from config | TODO: if config does not exist, extract from db
        this._pageSize = 50;
        this._timestampPath = "http://www.w3.org/ns/sosa/resultTime";
        this._metadata = config;
        const date = new Date("2022-08-07T08:08:21Z"); // TODO: replace with real value

        if (await this.bucketExists(this.root)) {
            return
        }

        // only if the root does not exist yet
        await this.createBucket(this.root)

        // create first window
        const firstWindow : Window= {
            identifier: date.valueOf() + '',
            start: date
        }
        await this.createWindow(firstWindow);
        await this.addWindowToRoot(firstWindow);
    }


    async getMostRecentWindow(): Promise<Window> {
        const mostRecentBucket = await this.dbIndexCollection.find({ streamId: this.sdsStreamIdentifier }).sort({ "start": -1 }).limit(1).next();
        if (!mostRecentBucket) {
            throw Error("No buckets present")
        }

        return this.documentToWindow(mostRecentBucket);
    }

    /**
     * Transforms a MongoDB document to a {@link Window}.
     * @param document
     * @returns
     */
    protected documentToWindow(document: WithId<Document>): Window {
        return {
            identifier: document.id,
            memberIdentifiers: document.members,
            start: new Date(document.start),
            end: new Date(document.start)
        }
    }

    async bucketSize(window: Window): Promise<number> {
        const bucket = await this.dbIndexCollection.findOne({ id: window.identifier, streamId: this.sdsStreamIdentifier });
        if (!bucket) {
            throw Error("Window with identifier " + window.identifier + " was not found in the database");
        }
        return bucket.members.length;
    }

    async createWindow(window: Window): Promise<void> {
        const { identifier, start, end } = window;

        await this.createBucket(identifier);

        const windowParams: any = {};
        if (start) {
            windowParams.start = start.toISOString();
        }
        if (end) {
            windowParams.end = end.toISOString();
        }
        await this.dbIndexCollection.updateOne({ streamId: this.sdsStreamIdentifier, id: identifier }, { "$set": windowParams });
    }

    async updateWindow(window: Window): Promise<void> {
        const { identifier, start, end } = window;

        const windowParams: any = {};
        if (start) {
            windowParams.start = start.toISOString();
        }
        if (end) {
            windowParams.end = end.toISOString();
        }
        await this.dbIndexCollection.updateOne({ streamId: this.sdsStreamIdentifier, id: identifier }, { "$set": windowParams })
    }

    async addWindowToRoot(window: Window): Promise<void> {
        const { identifier, start } = window;

        if (!start) throw Error("Can not add window " + identifier + " to the root as it has no start date value");
        await this.addRelationsToBucket(this.root, [{
            type: RelationType.GreaterThanOrEqualTo,
            value: start.toISOString(),
            path: this.timestampPath,
            bucket: identifier
        }])
    }

    async append(member: Member): Promise<void> {
        const currentWindow = await this.getMostRecentWindow();
        const bucketSize = await this.bucketSize(currentWindow);

        if (bucketSize + 1 > this.pageSize) {
            const memberDate = extractDate(new Store(member.quads), this.timestampPath);
            const newWindow : Window= {
                identifier: memberDate.valueOf() + '',
                start: memberDate
            }
            // create new window
            await this.createWindow(newWindow);
            await this.addWindowToRoot(newWindow)

            // add end date to old window
            currentWindow.end = memberDate;
            await this.updateWindow(currentWindow)
            await this.addRelationsToBucket(this.root, [{
                type: RelationType.LessThan,
                value: memberDate.toISOString(),
                path: this.timestampPath,
                bucket: currentWindow.identifier
            }])
        } else {
            await this.storeMember(member);
            await this.addMemberstoBucket(currentWindow.identifier, [member.id.value]);
        }
    }
    async publish(members: Member[]): Promise<void> {
        // inefficient implementation
        for (const member of members) {
            await this.append(member);
        }
    }
}
