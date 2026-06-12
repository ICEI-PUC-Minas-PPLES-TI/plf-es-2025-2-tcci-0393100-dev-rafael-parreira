package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// errEmailTaken is returned by dbCreateUser when the email is already registered.
var errEmailTaken = errors.New("email already in use")

// userDoc is the MongoDB document shape for the users collection.
type userDoc struct {
	ID           int    `bson:"id"`
	Name         string `bson:"name"`
	Email        string `bson:"email"`
	PasswordHash string `bson:"password_hash"`
}

// telemetryEventDoc stores one Puppeteer event line in MongoDB.
type telemetryEventDoc struct {
	SessionID string `bson:"sessionId"`
	Seq       int    `bson:"seq"`
	Event     string `bson:"event"` // extracted event type for potential filtering
	Raw       string `bson:"raw"`   // original JSON line, preserved exactly
}

var (
	mongoClient *mongo.Client
	mongoDB     *mongo.Database
)

// connectMongoDB reads MONGODB_URI / MONGODB_DB from the environment, connects,
// and stores the client + database in package-level variables.
func connectMongoDB() error {
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://localhost:27017"
	}
	dbName := os.Getenv("MONGODB_DB")
	if dbName == "" {
		dbName = "stream_sentry"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(uri))
	if err != nil {
		return err
	}
	if err := client.Ping(ctx, nil); err != nil {
		return err
	}

	mongoClient = client
	mongoDB = client.Database(dbName)
	log.Printf("MongoDB: conectado → %s / db=%q", uri, dbName)
	return nil
}

// disconnectMongoDB gracefully closes the MongoDB connection.
func disconnectMongoDB() {
	if mongoClient == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = mongoClient.Disconnect(ctx)
}

func colUsers() *mongo.Collection       { return mongoDB.Collection("users") }
func colTestHistory() *mongo.Collection { return mongoDB.Collection("test_history") }
func colTelemetry() *mongo.Collection   { return mongoDB.Collection("telemetry_events") }

// ensureIndexes creates the necessary indexes on startup.
func ensureIndexes(ctx context.Context) {
	_, _ = colUsers().Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "email", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	_, _ = colUsers().Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "id", Value: 1}},
	})
	_, _ = colTelemetry().Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "sessionId", Value: 1}, {Key: "seq", Value: 1}},
	})
	_, _ = colTestHistory().Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "id", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
}

// nextUserID returns the next sequential integer user ID via an atomic counter document.
func nextUserID(ctx context.Context) (int, error) {
	type counter struct {
		Seq int `bson:"seq"`
	}
	var result counter
	err := mongoDB.Collection("counters").FindOneAndUpdate(
		ctx,
		bson.M{"_id": "user_id"},
		bson.M{"$inc": bson.M{"seq": 1}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After),
	).Decode(&result)
	return result.Seq, err
}

// ── User helpers ─────────────────────────────────────────────────────────────

func dbFindUserByEmail(ctx context.Context, email string) (*userDoc, error) {
	var doc userDoc
	err := colUsers().FindOne(ctx, bson.M{"email": email}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &doc, err
}

func dbFindUserByID(ctx context.Context, id int) (*userDoc, error) {
	var doc userDoc
	err := colUsers().FindOne(ctx, bson.M{"id": id}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &doc, err
}

func dbCreateUser(ctx context.Context, doc userDoc) error {
	_, err := colUsers().InsertOne(ctx, doc)
	if mongo.IsDuplicateKeyError(err) {
		return errEmailTaken
	}
	return err
}

// ── Telemetry helpers ────────────────────────────────────────────────────────

// dbInsertTelemetryEvent stores one raw JSON line from the Puppeteer runner.
func dbInsertTelemetryEvent(ctx context.Context, sessionID string, seq int, line []byte) error {
	var evName string
	var m map[string]any
	if json.Unmarshal(line, &m) == nil {
		evName, _ = m["event"].(string)
	}
	_, err := colTelemetry().InsertOne(ctx, telemetryEventDoc{
		SessionID: sessionID,
		Seq:       seq,
		Event:     evName,
		Raw:       string(line),
	})
	return err
}

// dbLoadSessionEvents returns all raw JSON lines for a session in order.
func dbLoadSessionEvents(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	cur, err := colTelemetry().Find(ctx,
		bson.M{"sessionId": sessionID},
		options.Find().SetSort(bson.D{{Key: "seq", Value: 1}}),
	)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var out []json.RawMessage
	for cur.Next(ctx) {
		var doc telemetryEventDoc
		if err := cur.Decode(&doc); err != nil {
			continue
		}
		out = append(out, json.RawMessage(doc.Raw))
	}
	return out, cur.Err()
}

// ── Test history helpers ─────────────────────────────────────────────────────

// jsonToDoc converts any value to bson.M via a JSON round-trip.
// This lets us store structs that only carry json tags (not bson tags) in MongoDB.
func jsonToDoc(v any) (bson.M, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var doc bson.M
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return doc, nil
}

func dbAppendTestHistory(ctx context.Context, rec TestHistoryRecord) error {
	doc, err := jsonToDoc(rec)
	if err != nil {
		return err
	}
	_, err = colTestHistory().InsertOne(ctx, doc)
	return err
}

func dbLoadTestHistory(ctx context.Context) ([]TestHistoryRecord, error) {
	cur, err := colTestHistory().Find(ctx, bson.M{},
		options.Find().SetSort(bson.D{{Key: "startedAt", Value: 1}}),
	)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	out := []TestHistoryRecord{}
	for cur.Next(ctx) {
		var raw bson.M
		if err := cur.Decode(&raw); err != nil {
			continue
		}
		b, err := json.Marshal(raw)
		if err != nil {
			continue
		}
		var rec TestHistoryRecord
		if err := json.Unmarshal(b, &rec); err != nil {
			continue
		}
		out = append(out, rec)
	}
	return out, cur.Err()
}

func dbFindTestHistoryRecord(ctx context.Context, id string) (*TestHistoryRecord, error) {
	var raw bson.M
	err := colTestHistory().FindOne(ctx, bson.M{"id": id}).Decode(&raw)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var rec TestHistoryRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}
