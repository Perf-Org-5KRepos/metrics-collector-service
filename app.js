// Licensed under the Apache 2.0 License. See footer for details.
var express = require("express"),
    http = require("http"),
    path = require("path"),
    cloudant = require("cloudant"),
    dotenv = require("dotenv"),
    validator = require("validator"),
    bodyParser = require("body-parser"),
    passport = require("passport"),
    cfenv = require("cfenv"),
    cookieParser = require("cookie-parser"),
    IbmIdStrategy = require("passport-idaas-openidconnect").IDaaSOIDCStrategy,
    expressSession = require("express-session"),
    memoryStore = new expressSession.MemoryStore(),
    RedisStore = require("connect-redis")(expressSession),
    _ = require("underscore"),
    crypto = require("crypto"),
    csv = require("express-csv"), // jshint ignore:line
    hbs = require("hbs"),
    restler = require("restler"),
    forceSSL = require("express-force-ssl"),
    async = require("async"),
    metric = require('./metric'),
    fs = require("fs");


dotenv.load();

var appEnv = cfenv.getAppEnv();

var forceSslIfNotLocal = function(req, res, next) {
    if (appEnv.isLocal) {
        return next();
    }
    forceSSL(req, res, next);
};

var app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(cookieParser());

app.enable("trust proxy");

var sessionStore;

if (!appEnv.isLocal) {
    var redisService = appEnv.getService(new RegExp(".*" + "deployment-tracker-redis" + ".*", "i"));

    sessionStore = new RedisStore({
        host: redisService.credentials.hostname,
        port: redisService.credentials.port,
        pass: redisService.credentials.password
    });
} else {
    sessionStore = memoryStore;
}

//in future PR switch to redis or cloudant as a session store
app.use(expressSession({
    secret: process.env.SECRET || "blah",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        path: "/",
        httpOnly: true
    }
}));

var API_KEY = process.env.API_KEY || "blah",
    GITHUB_STATS_API_KEY = process.env.GITHUB_STATS_API_KEY || "";

app.use(passport.initialize());
app.use(passport.session());

String.prototype.endsWith = function(suffix) {
    return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

function authenticate() {
    return function(request, response, next) {
        if (appEnv.isLocal) {
            return next();
        }
        console.log(request.session);
        if (!request.isAuthenticated() || request.session.passport.user === undefined) {
            response.redirect("/auth/sso");
            return next();
        }

        var email = request.session.passport.user.id,
            ibmer = false;

        if (email.toLowerCase().endsWith(".ibm.com") || email.toLowerCase().endsWith("@ibm.com")) {
            ibmer = true;
        }
        if (ibmer === false) {
            response.render("error", {
                message: "You must be an IBM'er to use this app"
            });
        }
        return next();
    };
}

function checkAPIKey() {
    return function(request, response, next) {
        if (appEnv.isLocal) {
            return next();
        }

        if (request.query.apiKey === undefined) {
            response.status(403);
            response.json({
                "error": "A query string parameter apiKey must be set"
            });
        } else if (request.query.apiKey !== API_KEY) {
            response.status(403);
            response.json({
                "error": "Invalid api key"
            });
        }

        return next();
    };
}

passport.serializeUser(function(user, done) {
    done(null, user);
});

passport.deserializeUser(function(obj, done) {
    done(null, obj);
});

var SSO_CLIENT_ID = (process.env.SSO_CLIENT_ID || " "),
    SSO_CLIENT_SECRET = (process.env.SSO_CLIENT_SECRET || " "),
    SSO_URL = (process.env.SSO_URL || "");

var callbackURL = "https://deployment-tracker.mybluemix.net" + "/auth/sso/callback";
if (process.env.BASE_URL) {
    callbackURL = "https://" + process.env.BASE_URL + "/auth/sso/callback";
}

var Strategy = new IbmIdStrategy({
        authorizationURL: SSO_URL + "/idaas/oidc/endpoint/default/authorize",
        tokenURL: SSO_URL + "/idaas/oidc/endpoint/default/token",
        clientID: SSO_CLIENT_ID,
        scope: "email",
        response_type: "code",
        clientSecret: SSO_CLIENT_SECRET,
        callbackURL: callbackURL,
        skipUserProfile: true,
        issuer: SSO_URL
    },
    function(iss, sub, profile, accessToken, refreshToken, params, done) { // jshint ignore:line
        process.nextTick(function() {
            profile.accessToken = accessToken;
            profile.refreshToken = refreshToken;
            done(null, profile);
        });
    }
);

passport.use(Strategy);

app.get("/auth/sso", [forceSslIfNotLocal], passport.authenticate("openidconnect", {}));

app.get("/auth/sso/callback", [forceSslIfNotLocal,
        passport.authenticate("openidconnect", {
            failureRedirect: "/error"
        })
    ],
    function(req, res) {
        res.redirect("/stats");
    });

app.get("/logout", forceSslIfNotLocal, function(request, response) {
    passport._strategy("openidconnect").logout(request, response, appEnv.url);
});

(function(app) {
    if (process.env.VCAP_SERVICES) {
        var vcapServices = JSON.parse(process.env.VCAP_SERVICES);
        app.set("vcapServices", vcapServices);
        if (vcapServices.cloudantNoSQLDB && vcapServices.cloudantNoSQLDB.length > 0) {
            var service = vcapServices.cloudantNoSQLDB[0];
            if (service.credentials) {
                app.set("deployment-tracker-db", cloudant({
                    username: service.credentials.username,
                    password: service.credentials.password,
                    account: service.credentials.username
                }));
            }
        }
    }
})(app);

var urlEncodedParser = bodyParser.urlencoded({
        extended: false
    }),
    jsonParser = bodyParser.json();

function getStats(repo, callback) {
    var baseURL = "https://github-stats.mybluemix.net/api/v1/stats";

    if (GITHUB_STATS_API_KEY === "") {
        callback(null, null);
        return;
    }

    var url = baseURL + "?apiKey=" + GITHUB_STATS_API_KEY + "&repo=" + repo;

    if (!appEnv.isLocal) {
        sessionStore.client.get("repo-" + repo, function(err, result) {
            if (err || !result) {
                restler.get(url).on("complete", function(data) {
                    sessionStore.client.setex("repo-" + repo, 21600, JSON.stringify(data));
                    callback(null, data);
                });
            } else {
                callback(null, JSON.parse(result));
            }
        });
    } else {
        restler.get(url).on("complete", function(data) {
            callback(null, data);
        });
    }
}

// Get the IBM Code User metrics overview
app.get("/users", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var eventsDb = deploymentTrackerDb.use("usagedata");
    eventsDb.get('services', function(err, body) {
        if (!err) {
            try {
                var users = body['users'];
                // var revenue = body['serviceCost'];
                var sum = 0;
                body['userGeo'].forEach(function(country) {
                    sum += parseInt(country.value);
                })
                var userGeo = metric.listTopServices(body['userGeo'], sum);
                res.render("users", {
                    users: JSON.stringify(users),
                    userGeo: JSON.stringify(userGeo)
                });
            } catch (ex) {}
        }
    });
});

// Get the Bot asset exchange metrics overview
app.get("/chatbot", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var eventsDb = deploymentTrackerDb.use("usagedata");
    eventsDb.get('services', function(err, body) {
        if (!err) {
            try {
                var sum = 0;
                body['chatbot'].forEach(function(botname) {
                    sum += parseInt(botname.value);
                })
                var chatbot = metric.listTopServices(body['chatbot'], sum);
                res.render("chatbot", {
                    chatbot: JSON.stringify(chatbot)
                });
            } catch (ex) {}
        }
    });
});

// API for the Bot asset exchange metrics overview
// app.get("/chatbotjson", [forceSslIfNotLocal, authenticate()], function(req, res) {
//   var app = req.app;
//   var deploymentTrackerDb = app.get("deployment-tracker-db");
//   if (!deploymentTrackerDb) {
//     return res.status(500);
//   }
//   var eventsDb = deploymentTrackerDb.use("usagedata");
//   eventsDb.get('services',function (err, body) {
//       if(!err){
//         try{
//           res.json(body['chatbot']);
//         }catch(ex){
//         }
//       }
//     });
// });

// Get the IBM Cloud Usage metrics overview
app.get("/bluemix", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var eventsDb = deploymentTrackerDb.use("usagedata");
    eventsDb.get('services', function(err, body) {
        if (!err) {
            try {
                var bluemixOutput = body['servicesAllBluemix'];
                var cfBluemix = body['cfBluemix'];
                var kubernetesBluemix = body['kubernetesBluemix'];
                res.render("bluemix", {
                    dataTotal: JSON.stringify(bluemixOutput),
                    cfBluemix: JSON.stringify(cfBluemix),
                    kubernetesBluemix: JSON.stringify(kubernetesBluemix)
                });
            } catch (ex) {}
        }
    });
});

// Get the Usage metrics overview
app.get("/graphs", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var eventsDb = deploymentTrackerDb.use("usagedata");
    eventsDb.get('services', function(err, body) {
        if (!err) {
            try {
                var output = body['services'];
                var usage = body['usage'];
                var cloudfoundry = body['cloudfoundry'];
                var kubernetes = body['kubernetes'];
                usage.forEach(function(service) {
                    service["key2"] = service.key.replace(/\s+/g, '');
                });
                res.render("graphs", {
                    dataW: JSON.stringify(output),
                    dataRaw: usage,
                    cloudfoundry: JSON.stringify(cloudfoundry),
                    kubernetes: JSON.stringify(kubernetes)
                });
            } catch (ex) {}
        }
    });
});

// Get the Usage metrics for a specific service
app.get("/graphs/:hash", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var hash = req.params.hash;
    var serviceTitle = '';
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var eventsDb = deploymentTrackerDb.use("usagedata");
    var usagePerUnit = [];
    var perUnit = [];
    eventsDb.get('services', function(err, body) {
        if (!err) {
            try {
                var usageperservice = body['usagePerService'];
                usageperservice.forEach(function(service) {
                    service["key2"] = service.key.replace(/\s+/g, '');
                    if (hash == service.key.replace(/\s+/g, '')) {
                        serviceTitle = String(service.key);
                        usagePerUnit = service.value;
                        perUnit = Object.keys(usagePerUnit).map(function(key) {
                            return {
                                key: key,
                                value: usagePerUnit[key]
                            };
                        });
                    }
                });
                res.render("service", {
                    dataU: JSON.stringify(usagePerUnit),
                    dataRaw: perUnit,
                    service: serviceTitle
                });
            } catch (ex) {}
        }
    });
});

// Get the specific service metrics for a specific company
app.get("/company/:hash/:service", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var hash = req.params.hash;
    var comService = req.params.service;
    var serviceTitle = '';
    var companyTitle = '';
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var eventsDb = deploymentTrackerDb.use("usagedata");
    var usage = [];
    var usagePerUnit = [];
    var perUnit = [];
    eventsDb.get('services', function(err, body) {
        if (!err) {
            try {
                var companies = body['companyData'];
                Object.keys(companies).map(function(company) {
                    var companyKey = company.replace(/\s+/g, '');
                    if (hash == companyKey) {
                        companyTitle = String(company);
                        usage = companies[company]["serviceUnit"];
                        usage.forEach(function(service) {
                            var serviceName = service.key.replace(/\s+/g, '');
                            if (comService == serviceName) {
                                serviceTitle = String(service.key);
                                usagePerUnit = service.value;
                                perUnit = Object.keys(usagePerUnit).map(function(key) {
                                    return {
                                        key: key,
                                        value: usagePerUnit[key]
                                    };
                                });
                            }
                        });
                    }
                });
                res.render("company_service", {
                    dataU: JSON.stringify(usagePerUnit),
                    dataRaw: perUnit,
                    service: serviceTitle,
                    company: companyTitle,
                    companyHash: hash
                });
            } catch (ex) {}
        }
    });
});

// Get metrics for a specific company
app.get("/company/:hash", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var hash = req.params.hash;
    var companyTitle = '';
    var companyHash = '';
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var eventsDb = deploymentTrackerDb.use("usagedata");
    var cloudfoundry = [];
    var kubernetes = [];
    var services = [];
    var usage = {};
    eventsDb.get('services', function(err, body) {
        if (!err) {
            try {
                var companies = body['companyData'];
                Object.keys(companies).map(function(company) {
                    var companyKey = company.replace(/\s+/g, '').toLowerCase();
                    if (hash.toLowerCase() == companyKey) {
                        companyTitle = String(company);
                        cloudfoundry = companies[company]["cf"];
                        kubernetes = companies[company]["k8s"];
                        services = companies[company]["services"];
                        usage = companies[company]["usage"];
                        if (usage != null) {
                            usage.forEach(function(service) {
                                service["key2"] = service.key.replace(/\s+/g, '');
                                service["company"] = companyTitle.replace(/\s+/g, '');
                            });
                        } else {
                            usage = [];
                        }
                    }
                });
                res.render("company", {
                    cloudfoundry: JSON.stringify(cloudfoundry),
                    kubernetes: JSON.stringify(kubernetes),
                    dataRaw: usage,
                    dataW: JSON.stringify(services),
                    company: companyTitle
                });
            } catch (ex) {}
        }
    });
});

app.get("/", forceSslIfNotLocal, function(req, res) {
    res.render("index");
});

// Get Deployment metrics overview
function getStatsPage(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    if (!deploymentTrackerDb) {
        return res.status(500);
    }
    var eventsDb = deploymentTrackerDb.use("events");
    eventsDb.view("deployments", "by_repo_unique", {
        group_level: 4
    }, function(err, body) {
        var apps = {};
        body.rows.map(function(row) {
            var url = row.key[0];
            var year = row.key[1];
            var month = row.key[2];
            if (!(url in apps)) {
                apps[url] = {
                    url: url,
                    count: 0,
                    deploys: []
                };
                if (url) {
                    apps[url].url_hash = crypto.createHash("md5").update(url).digest("hex");
                }
            }
            if (validator.isURL(url, {
                    protocols: ["http", "https"],
                    require_protocol: true
                })) {
                apps[url].is_url = true;
            }
            if (!(year in apps[url].deploys)) {
                apps[url].deploys[year] = {};
            }
            if (!(month in apps[url].deploys[year])) {
                apps[url].deploys[year][month] = 1;
                apps[url].count += 1;
            } else {
                apps[url].deploys[year][month] += 1;
                apps[url].count += 1;
            }
        });

        //Get service and runtime count
        eventsDb.view("deployments", "by_runtime_service_unique", {
            group_level: 3
        }, function(err2, body2) {
            var usagedataDb = deploymentTrackerDb.use("usagedata");
            var output = [];
            var runtime = {};
            var service = {};
            var language = {};
            // var serviceCount = 0;
            body2.rows.map(function(row) {
                var item = row.key[0];
                if (item != null) {
                    item = item.toString().toLowerCase().replace(/-/g, " ");
                }
                var identifier = row.key[1];
                if (identifier == "runtimes") {
                    if (!(item in runtime)) {
                        runtime[item] = 1;
                    } else {
                        runtime[item] += 1;
                    }
                } else if (identifier == "services") {
                    if (!(item in service)) {
                        service[item] = 1;
                    } else {
                        service[item] += 1;
                    }
                } else if (identifier == "language") {
                    if (!(item in language)) {
                        language[item] = 1;
                    } else {
                        language[item] += 1;
                    }
                }
            });
            var runtimes = Object.keys(runtime).map(function(key) {
                return {
                    key: key.replace(/\b\w/g, l => l.toUpperCase()),
                    value: runtime[key]
                };
            });
            var activeServices = JSON.parse(fs.readFileSync("service_list.json"));
            var deprecated = [];

            for (var deprecate in service) {
                if (!activeServices.hasOwnProperty(deprecate)) {
                    deprecated.push(deprecate);
                }
            }

            for (var i = 0; i < deprecated.length; i++) {
                delete service[deprecated[i]];
            }
            var services = Object.keys(service).map(function(key) {
                // serviceCount += 1;
                return {
                    key: key.replace(/\b\w/g, l => l.toUpperCase()),
                    value: service[key]
                };
            });
            var languages = Object.keys(language).map(function(key) {
                return {
                    key: key.replace(/\b\w/g, l => l.toUpperCase()),
                    value: language[key]
                };
            });
            //sort count for each app
            metric.sortItem(runtimes);
            metric.sortItem(services);
            metric.sortItem(languages);
            async.forEachOf(apps, function(value, key, callback) {
                getStats(key, function(error, data) {
                    if (error) {
                        callback(error);
                    } else {
                        value.githubStats = data;
                        apps[key] = value;
                        callback(null);
                    }
                });
            }, function() {
                var appsSortedByCount = [];
                var sum = 0;
                for (var url in apps) {
                    sum += apps[url].count;
                    appsSortedByCount.push(apps[url]);
                }
                appsSortedByCount.sort(function(a, b) {
                    if (a.count < b.count) {
                        return -1;
                    }
                    if (a.count > b.count) {
                        return 1;
                    }
                    return 0;
                }).reverse();
                //Calculate top 5 repositories.
                var data = [];
                for (var i = 0; i < 5; i++) {
                    var link = appsSortedByCount[i].url;
                    var urlSuffix = link.split('.com/');
                    var repoPrefix = urlSuffix[urlSuffix.length - 1].split('.');
                    var key = repoPrefix[0];
                    var value = Math.round((appsSortedByCount[i].count / sum) * 10000) / 100
                    var item = {
                        "key": key,
                        "value": value
                    };
                    data.push(item);
                }
                var renderJson = {
                    data: JSON.stringify(data),
                    apps: appsSortedByCount,
                    services: JSON.stringify(services),
                    runtimes: JSON.stringify(runtimes),
                    languages: JSON.stringify(languages)
                };
                res.render("stats", renderJson);
                if (!appEnv.isLocal) {
                    sessionStore.client.setex("statsPage", 900, JSON.stringify(renderJson));
                }
            });
        });
    });
}

// Get metrics overview
app.get("/stats", [forceSslIfNotLocal, authenticate()], function(req, res) {
    // Cache using Redis
    if (!appEnv.isLocal) {
        sessionStore.client.get("statsPage", function(err, result) {
            if (err || !result) {
                getStatsPage(req, res);
            } else {
                res.render("stats", JSON.parse(result));
            }
        });
    } else {
        getStatsPage(req, res);
    }
});

// Get CSV of metrics overview
// app.get("/stats.csv", forceSslIfNotLocal, function(req, res) {
//   var app = req.app;
//   var deploymentTrackerDb = app.get("deployment-tracker-db");
//   if (!deploymentTrackerDb) {
//     return res.status(500);
//   }
//   var eventsDb = deploymentTrackerDb.use("events");
//   eventsDb.view("deployments", "by_repo", {group_level: 3}, function(err, body) {
//     var apps = [
//       ["URL", "Year", "Month", "Deployments"]
//     ];
//     body.rows.map(function(row) {
//       var url = row.key[0];
//       var year = row.key[1];
//       var month = row.key[2];
//       var count = row.value;
//       apps.push([url, year, month, count]);
//     });
//     res.csv(apps);
//   });
// });

// Get JSON of metrics overview
app.get("/repos", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");

    if (!deploymentTrackerDb) {
        return res.status(500);
    }

    var eventsDb = deploymentTrackerDb.use("events");
    eventsDb.view("deployments", "by_repo", {
        group_level: 3
    }, function(err, body) {
        var apps = [];

        body.rows.map(function(row) {
            var url = row.key[0];

            if (!_.contains(apps, url)) {
                apps.push(url);
            }
        });

        res.json(apps);
    });
});

// Get metrics for a specific repo
app.get("/stats/:hash", [forceSslIfNotLocal, authenticate()], function(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    var appsSortedByCount = [];

    if (!deploymentTrackerDb) {
        return res.status(500);
    }
    var eventsDb = deploymentTrackerDb.use("events");
    var hash = req.params.hash;

    eventsDb.view("deployments", "by_repo_hash_unique", {
        startkey: [hash],
        endkey: [hash, {}, {}, {}, {}],
        group_level: 5
    }, function(err, body) {
        var apps = {},
            protocolAndHost = req.protocol + "://" + req.get("host");
        body.rows.map(function(row) {
            var hash = row.key[0];
            var url = row.key[1];
            var year = row.key[2];
            var month = row.key[3];
            if (!(url in apps)) {
                apps[url] = {
                    url: url,
                    count: body.rows.length,
                    deploys: []
                };
                if (hash) {
                    apps[url].url_hash = hash;
                    apps[url].badgeImageUrl = protocolAndHost +
                        "/stats/" +
                        apps[url].url_hash +
                        "/badge.svg";
                    apps[url].badgeMarkdown = "![IBM Cloud Deployments](" +
                        apps[url].badgeImageUrl +
                        ")";
                    apps[url].buttonImageUrl = protocolAndHost +
                        "/stats/" +
                        apps[url].url_hash +
                        "/button.svg";
                    apps[url].buttonLinkUrl = "https://bluemix.net/deploy?repository=" +
                        url;
                    apps[url].buttonMarkdown = "[![Deploy to IBM Cloud](" +
                        apps[url].buttonImageUrl +
                        ")](" +
                        apps[url].buttonLinkUrl +
                        ")";
                }
            }
            if (validator.isURL(url, {
                    protocols: ["http", "https"],
                    require_protocol: true
                })) {
                apps[url].is_url = true;
            }
            if (!(year in apps[url].deploys)) {
                apps[url].deploys[year] = {};
            }
            if (!(month in apps[url].deploys[year])) {
                apps[url].deploys[year][month] = 1;
            } else {
                apps[url].deploys[year][month] += 1;
            }
        });
        for (var url in apps) {
            appsSortedByCount.push(apps[url]);
        }
        appsSortedByCount.sort(function(a, b) {
            if (a.count < b.count) {
                return -1;
            }
            if (a.count > b.count) {
                return 1;
            }
            return 0;
        }).reverse();
        getStats(appsSortedByCount[0].url, function(error, result) {
            if (!error) {
                appsSortedByCount[0].githubStats = result;
            }
            res.render("repo", {
                protocolAndHost: protocolAndHost,
                apps: appsSortedByCount
            });
        });
    });
});

// Public API to get metrics for a specific repo
// app.get("/stats/:hash/metrics.json", forceSslIfNotLocal, function(req, res) {
//   var app = req.app,
//     deploymentTrackerDb = app.get("deployment-tracker-db");

//   if (!deploymentTrackerDb) {
//     return res.status(500);
//   }
//   var eventsDb = deploymentTrackerDb.use("events"),
//    hash = req.params.hash;

//   //TODO: Consider caching this data with Redis
//   eventsDb.view("deployments", "by_repo_hash",
//     {startkey: [hash], endkey: [hash, {}, {}, {}, {}, {}, {}], group_level: 1}, function(err, body) {
//     var appStats = {
//       url_hash: hash,
//       count: body.rows[0].value
//     };
//     res.json(appStats);
//   });
// });

// Get badge of metrics for a specific repo
app.get("/stats/:hash/badge.svg", forceSslIfNotLocal, function(req, res) {
    var app = req.app,
        deploymentTrackerDb = app.get("deployment-tracker-db");

    if (!deploymentTrackerDb) {
        return res.status(500);
    }
    var eventsDb = deploymentTrackerDb.use("events"),
        hash = req.params.hash;

    //TODO: Consider caching this data with Redis
    eventsDb.view("deployments", "by_repo_hash_unique", {
        startkey: [hash],
        endkey: [hash, {}, {}, {}, {}],
        group_level: 5
    }, function(err, body) {
        var count = body.rows.length;
        //TODO: Rename this variable
        var svgData = {
            left: "IBM Cloud Deployments",
            right: count.toString(),
        };
        svgData.leftWidth = svgData.left.length * 6.5 + 10;
        svgData.rightWidth = svgData.right.length * 7.5 + 10;
        svgData.totalWidth = svgData.leftWidth + svgData.rightWidth;
        svgData.leftX = svgData.leftWidth / 2 + 1;
        svgData.rightX = svgData.leftWidth + svgData.rightWidth / 2 - 1;
        res.set({
            "Content-Type": "image/svg+xml",
            "Cache-Control": "no-cache",
            "Expires": 0
        });
        res.render("badge.xml", svgData);
    });
});

// Get a "Deploy to IBM Cloud" button for a specific repo
app.get("/stats/:hash/button.svg", forceSslIfNotLocal, function(req, res) {
    var app = req.app,
        deploymentTrackerDb = app.get("deployment-tracker-db");

    if (!deploymentTrackerDb) {
        return res.status(500);
    }
    var eventsDb = deploymentTrackerDb.use("events"),
        hash = req.params.hash;

    //TODO: Consider caching this data with Redis
    eventsDb.view("deployments", "by_repo_hash_unique", {
        startkey: [hash],
        endkey: [hash, {}, {}, {}, {}],
        group_level: 5
    }, function(err, body) {
        var count = body.rows.length;
        //TODO: Rename this variable
        var svgData = {
            left: "Deploy to IBM Cloud",
            right: count.toString(),
        };
        svgData.leftWidth = svgData.left.length * 11 + 20;
        svgData.rightWidth = svgData.right.length * 12 + 16;
        svgData.totalWidth = svgData.leftWidth + svgData.rightWidth;
        svgData.leftX = svgData.leftWidth / 2 + 1;
        svgData.rightX = svgData.leftWidth + svgData.rightWidth / 2 - 1;
        svgData.leftWidth = svgData.leftWidth + 48;
        svgData.totalWidth = svgData.totalWidth + 48;
        svgData.leftX = svgData.leftX + 48;
        svgData.rightX = svgData.rightX + 48;
        res.set({
            "Content-Type": "image/svg+xml",
            "Cache-Control": "no-cache",
            "Expires": 0
        });
        res.render("button.xml", svgData);
    });
});

function track(req, res) {
    var app = req.app;
    var deploymentTrackerDb = app.get("deployment-tracker-db");
    if (!deploymentTrackerDb) {
        return res.status(500).json({
            error: "No database server configured"
        });
    }
    if (!req.body) {
        return res.sendStatus(400);
    }

    if ((req.body.test) && (req.body.test === true)) {
        // This is a test request. 
        // Verify the payload and return appropriate status:
        //  200 {ok: true} if request meets the spec
        //  400 if request doesn't include all required properties
        //      {
        //       ok: false,
        //       missing: ["missing_property_name"]
        //      }
        var missing = _.filter(["application_id", "application_name",
                "repository_url", "runtime", "space_id", "config"
            ],
            function(property) {
                return (!(req.body[property]));
            });
        if (missing.length > 0) {
            return res.status(400).json({
                ok: false,
                missing: missing
            });
        } else {
            return res.status(200).json({
                ok: true
            });
        }
    }


    var event = {
        date_received: new Date().toJSON()
    };
    if (req.body.date_sent) {
        event.date_sent = req.body.date_sent;
    }
    if (req.body.code_version) {
        event.code_version = req.body.code_version;
    }
    if (req.body.repository_url) {
        event.repository_url = req.body.repository_url;
        event.repository_url_hash = crypto.createHash("md5").update(event.repository_url).digest("hex");
    }
    if (req.body.config) {
        try {
            if (req.body.config.repository_id) {
                if (req.body.config.repository_id.includes("/")) {
                    event.repository_url = req.body.config.repository_id;
                } else {
                    event.repository_url = "https://github.com/IBM/" + req.body.config.repository_id;
                }
                event.repository_url_hash = crypto.createHash("md5").update(event.repository_url).digest("hex");
            }
        } catch (ex) {
            console.log("Post request error: wrong format in repository.yaml");
        }
    }
    if (req.body.application_name) {
        event.application_name = req.body.application_name;
    }
    if (req.body.application_id) {
        // VCAP_APPLICATION.application_id
        event.application_id = req.body.application_id;
    }
    if (req.body.hasOwnProperty("instance_index")) {
        // VCAP_APPLICATION.instance_index (Index number of the application instance, e.g. 0,1,...)
        event.instance_index = req.body.instance_index;
    }
    if (req.body.space_id) {
        event.space_id = req.body.space_id;
    }
    if (req.body.application_version) {
        event.application_version = req.body.application_version;
    }
    if (req.body.application_uris) {
        if (!Array.isArray(req.body.application_uris)) {
            event.application_uris = [req.body.application_uris];
        } else {
            event.application_uris = req.body.application_uris;
        }
    }
    if (req.body.runtime) {
        event.runtime = req.body.runtime;
    }
    event.bound_services_general = [];
    if ((req.body.bound_vcap_services) && (Object.keys(req.body.bound_vcap_services).length > 0)) {
        event.bound_vcap_services = req.body.bound_vcap_services;
        Object.keys(req.body.bound_vcap_services).forEach(function(service_label) {
            event.bound_services_general.push(service_label);
        });
    } else {
        event.bound_vcap_services = {};
    }
    event.bound_services = [];
    if (req.body.bound_services) {
        event.bound_services = req.body.bound_services;
    }
    var provider = '';
    if (req.body.provider) provider = req.body.provider;
    if (req.body.config) event.config = req.body.config;
    if (req.body.bot_name) event.chatbot_name = req.body.bot_name;
    if (req.body.service_id) event.service_id = req.body.service_id;
    var kube = {};
    if (req.body.clusterid) kube.cluster_id = req.body.clusterid;
    if (req.body.customerid) kube.customer_id = req.body.customerid;
    //Sent data to Segment
    metric.sentAnalytic(event, req.body.config, provider, kube);
    if (provider) event.provider = provider;

    var eventsDb = deploymentTrackerDb.use("events");
    eventsDb.insert(event, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({
                error: "Internal Server Error"
            });
        }
        return res.status(201).json({
            ok: true
        });
    });
}

app.post("/", urlEncodedParser, track);

app.post("/api/v1/track", jsonParser, track);

app.get("/api/v1/whoami", [forceSslIfNotLocal, authenticate()], function(request, response) {
    response.send(request.session.passport.user);
});

app.get("/api/v1/stats", [forceSslIfNotLocal, authenticate()], function(request, response) {
    var repo = request.query.repo;

    if (GITHUB_STATS_API_KEY === "") {
        response.json({
            "error": "GITHUB_STATS_API_KEY is not server on the server"
        });
        return;
    }

    getStats(repo, function(error, result) {
        if (error) {
            response.send(error);
        } else {
            response.json(result);
        }
    });
});

app.get("/error", function(request, response) {
    response.render("error", {
        message: "Failed to authenticate"
    });
});

//prevent this page getting indexed
app.get("/robots.txt", function(request, response) {
    response.send("User-agent: *\nDisallow: /");
});

// Set the view engine
app.set("view engine", "html");
app.engine("html", hbs.__express);
app.engine("xml", hbs.__express);

// Serve static assets
app.use(express.static(path.join(__dirname, "public")));

// Create the HTTP server
http.createServer(app).listen(appEnv.port, appEnv.bind, function() {
    console.log("server starting on " + appEnv.url);
});
//-------------------------------------------------------------------------------
// Copyright IBM Corp. 2015
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//-------------------------------------------------------------------------------