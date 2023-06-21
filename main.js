import LemmyBot from 'lemmy-bot';
import chalk from 'chalk';
import sqlite3 from 'sqlite3';
import Parser from 'rss-parser';
import 'dotenv/config';

let parser = new Parser({
    customFields: {
      item: ['image'],
    }
});
console.log(`${chalk.magenta('STARTED:')} Started Bot`)

// -----------------------------------------------------------------------------
// Databases

const db = new sqlite3.Database('mega.sqlite3', (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the database.');

    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link TEXT NOT NULL UNIQUE,
        pin_days INTEGER NOT NULL DEFAULT 0,
        message_id INTEGER,
        featured INTEGER DEFAULT 0
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Loaded posts table.');
    });

    db.run(`CREATE TABLE IF NOT EXISTS time (
        key TEXT PRIMARY KEY,
        value INTEGER
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Loaded time table');

        db.run(`INSERT OR IGNORE INTO time (key, value) VALUES ('day', 0)`, (err) => {
            if (err) {
                return console.error(err.message);
            }
        });
    });

        // get all posts
    db.all(`SELECT COUNT(*) as count FROM posts`, (err, rows) => {
        if (err) {
            return console.error(err.message);
        }

        console.log(`${chalk.magenta('POSTS:')} ${rows[0].count} posts in database.`)
    });
});

// -----------------------------------------------------------------------------
// Data

const communities = [
    {
        slug: 'godot',
        instance: 'programming.dev',
        feeds: [
            'godot',
        ]
    },
    {
        slug: 'unreal_engine',
        instance: 'programming.dev',
        feeds: [
            'unreal',
        ]
    },
]

const feeds = [
    {
        name: 'godot',
        url: 'https://godotengine.org/rss.xml',
        pinCategories: [
            { name: 'Release', days: 7 },
            { name: 'Pre-Release', days: 7 },
        ],
    },
    {
        name: 'unreal',
        url: 'https://www.unrealengine.com/en-US/rss',
        content: 'summary',
    },
    {
        name: 'unity',
        url: 'https://blogs.unity3d.com/feed/',
    }
]

// -----------------------------------------------------------------------------
// Main Bot Code

// Create the list of communities the bot will be interacting in
const allowList = []

for (const community of communities) {
    const allowListEntry = allowList.find((item) => item.instance == community.instance)

    if (allowListEntry) {
        allowListEntry.communities.push(community.slug)
    }
    else {
        allowList.push({
            instance: community.instance,
            communities: [community.slug]
        })
    }
}


const bot = new LemmyBot.LemmyBot({
    instance: process.env.INSTANCE,
    credentials: {
        username: process.env.USERNAME,
        password: process.env.PASSWORD,
    },
    dbFile: 'db.sqlite3',
    federation: {
        allowList: allowList,
    },
    handlers: {
        post: {
            handle: async ({
                postView: {
                    post,
                    creator
                },
                botActions: { featurePost },
            }) => {
                // Pin post if its by the bot and set to be pinned
                if (creator.name == process.env.USERNAME) {
                    // get link from db. If pin days > 0 then pin
                    db.run(`SELECT * FROM posts WHERE link = ?`, [post.url], async (err, row) => {
                        if (err) {
                            return console.error(err.message);
                        }

                        if (row) {
                            if (row.pin_days > 0) {
                                // Pin post
                                await featurePost({postId: post.id, featureType: "Community", featured: true})
                                console.log(`${chalk.green('PINNED:')} Pinned ${post.name} in ${post.community_id} by ${creator.name}`)
                            }
                        }
                    });
                }
            }
        }
    },
    schedule: [
        {
            cronExpression: '0 */10 * * * *',
            timezone: 'America/Toronto',
            doTask: async ({getCommunityId, createPost}) => {
                for (const feed of feeds) {
                    const rss = await parser.parseURL(feed.url);

                    for (const item of rss.items) {
                        let pin_days = 0;
                        // if has categories then see if it's a pin
                        if (item.categories) {
                            for (const category of item.categories) {
                                const found_category = feed.pinCategories.find(c => c.name === category);
                                if (found_category) {
                                    pin_days = found_category.days;
                                }
                            }
                        }

                        db.run(`INSERT INTO posts (link, pin_days, featured) VALUES (?, ?, ?)`, [item.link, pin_days, pin_days > 0 ? 1 : 0], async (err) => {
                            if (err) {
                                if (err.message.includes('UNIQUE constraint failed')) {
                                    // do nothing
                                    return;
                                } else {
                                    return console.error(err.message);
                                }
                            }

                            for (const community of communities) {
                                if (community.feeds.includes(feed.name)) {
                                    const communityId = await getCommunityId(community.slug)
                                    await createPost({
                                        title: item.title,
                                        body: ((feed.content && feed.content === 'summary') ? item.summary : item.content),
                                        url: item.link || undefined,
                                        community_id: communityId,
                                    });
                                }
                            }
                            console.log(`${chalk.green('ADDED:')} ${item.link} for ${pin_days} days`);
                        });
                    }
                }
            }
        },
        {
            cronExpression: '0 */5 * * * *',
            timezone: 'America/Toronto',
            doTask: async ({ featurePost }) => {
                const now = addMinutes(new Date(), 30);
                const day = now.getDay();

                db.get(`SELECT value FROM time WHERE key = 'day'`, (err, row) => {
                    if (err) {
                        return console.error(err.message);
                    }

                    if (row.value !== day) {
                        db.run(`UPDATE time SET value = ${day} WHERE key = 'day'`, (err) => {
                            if (err) {
                                return console.error(err.message);
                            }
                        });

                        console.log(`${chalk.magenta('TIME:')} Updated day to ${day}`);
                        // decrement all post times by 1
                        db.run(`UPDATE posts SET pin_days = pin_days - 1 WHERE featured = 1`, (err) => {
                            if (err) {
                                return console.error(err.message);
                            }

                            console.log(`${chalk.magenta('TIME:')} Decremented all post times`);

                            // get all posts with 0 days left and unpin them
                            db.all(`SELECT * FROM posts WHERE pin_days = 0 && featured = 1`, async (err, rows) => {
                                if (err) {
                                    return console.error(err.message);
                                }

                                for (const row of rows) {
                                    await featurePost({postId: row.post_id, featureType: "Community", featured: false})
                                    console.log(`${chalk.green('UNFEATURED:')} Unfeatured ${row.post_id} in ${row.community_id}`);
                                }

                                // set all posts with 0 days left to unfeatured
                                db.run(`UPDATE posts SET featured = 0 WHERE pin_days = 0 AND featured = 1`, (err) => {
                                    if (err) {
                                        return console.error(err.message);
                                    }

                                    console.log(`${chalk.magenta('TIME:')} Unfeatured all posts with 0 days left`);
                                });
                            });
                        });
                    }
                });
            }
        }
    ]
});

bot.start();