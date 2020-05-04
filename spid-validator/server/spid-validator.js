const express = require("express");
const exphbs  = require('express-handlebars');
const helmet = require("helmet");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require('path');
const fs = require("fs-extra");
const moment = require("moment"); 

const config_test = require("../config/test.json");
const config_idp = require("../config/idp.json");
const config_dir = require("../config/dir.json");

const Utility = require("./lib/utils");
const TestSuite = require("./lib/saml-utils").TestSuite;
const PayloadDecoder = require("./lib/saml-utils").PayloadDecoder;
const MetadataParser = require("./lib/saml-utils").MetadataParser;
const RequestParser = require("./lib/saml-utils").RequestParser;
const IdP = require("./lib/saml-utils").IdP;
const Signer = require("./lib/signer").Signer;
const SIGN_MODE = require("./lib/signer").SIGN_MODE;

const Database = require("./lib/database");
const Authenticator = require("./lib/authenticator");



var app = express();
app.use(helmet());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.resolve(__dirname, "..", "client/build/assets")));
app.use("/assets", express.static(path.resolve(__dirname, "..", "client/build/assets")));

app.set('trust proxy', 1);
app.use(session({ 
    secret: "SAML IDP", 
    resave: true, 
    saveUninitialized: false, 
    cookie: { maxAge: 60*60000 }  //30*60000: 30min
}));


// create database
var database = new Database().connect().setup();

// create authenticator
var authenticator = new Authenticator("validator");

// use template handlebars
app.set('views', './client/view');
app.engine('handlebars', exphbs({defaultLayout: false}));
app.set('view engine', 'handlebars');


// Private Funcs

var getValidationInfo = function(user, code) {
    let store = null;

    if(code!=null && code!='') {
        store = database.getStoreByCode(user, code, "main");
    }

    let result = { 
        metadata_strict: false,
        metadata_certs: false,
        metadata_extra: false,
        request_strict: false,
        request_certs: false,
        request_extra: false,
        response_done: false,
        response_success: false,
        response_validation: false,
        validation: false
    };

    if(store) {
        let test_done = store.response_test_done? Object.keys(store.response_test_done) : [];
        let test_success = store.response_test_success? store.response_test_success : [];
        
        let tests = Object.keys(config_test['test-suite-1']['cases']);
        let test_done_ok = (test_done.length==tests.length);
        let test_success_ok = true;

        let test_success_num = 0;
        for(t in test_success) { 
            if(!test_success[t]) test_success_ok = false;
            else test_success_num++;
        }

        let response_validation = false;
        if(test_done_ok && test_success_ok) response_validation = true;
            
        let validation = false;
        if(store.metadata_validation_strict && 
            store.metadata_validation_certs &&
            store.metadata_validation_extra &&
            store.request_validation_strict &&
            store.request_validation_certs &&
            store.request_validation_extra &&
            //response_validation &&
            true
        ) validation = true;

        result = { 
            metadata_strict: store.metadata_validation_strict,
            metadata_certs: store.metadata_validation_certs,
            metadata_extra: store.metadata_validation_extra,
            request_strict: store.request_validation_strict,
            request_certs: store.request_validation_certs,
            request_extra: store.request_validation_extra,
            response_num: tests.length,
            response_done: test_done.length,
            response_success: test_success_num,
            response_validation: response_validation,
            validation: validation 
        };      
    }

    Utility.log("Validation result", result);
    return result;
}

var getMetadataInfo = function(code) {
    let store = null;
    if(code!=null && code!='') {
        store = database.getMetadataByCode(code, "main");
    }
    return store;
}

var sendLogoutResponse = function(req, res) {

    if(req.session!=null && req.session.request!=null && req.session.request.issuer!=null) {

        // default params if no authnrequest
        let authnRequestID = (req.session.request!=null)? req.session.request.id : Utility.getUUID();
        let issueInstant = (req.session.request!=null)? req.session.request.issueInstant : Utility.getInstant();
        let assertionConsumerURL = (req.session.request!=null)? req.session.request.assertionConsumerServiceURL : null;
        let assertionConsumerIndex = (req.session.request!=null)? req.session.request.assertionConsumerServiceIndex : null;
        
        // if no AssertionConsumerURL from request try to get it from metadata
        if((assertionConsumerURL==null || assertionConsumerURL=="") &&
            (assertionConsumerIndex!=null && assertionConsumerIndex!="")) {

            if(req.session.metadata!=null) {
                let metadataParser = new MetadataParser(req.session.metadata.xml);
                assertionConsumerURL = metadataParser.getAssertionConsumerServiceURL(assertionConsumerIndex);
            }
        }

        let requestedAttributes = [];
        let serviceProviderEntityId = "";
        let singleLogoutServiceURL = [];

        let isMetadataLoaded = (req.session.metadata!=null && req.session.metadata.xml!=null);
        
        if(req.session.request!=null && isMetadataLoaded) {
            let requestParser = new RequestParser(req.session.request.xml);
            let metadataParser = new MetadataParser(req.session.metadata.xml);
            serviceProviderEntityId = metadataParser.getServiceProviderEntityId();
            singleLogoutServiceURL = metadataParser.getSingleLogoutServiceURL();

        } else {
            requestedAttributes = true;
        }

        // defaults 
        let defaults = []; // clone array
        defaults = Utility.defaultParam(defaults, "ResponseID", Utility.getUUID());
        defaults = Utility.defaultParam(defaults, "IssueInstant", Utility.getInstant());
        defaults = Utility.defaultParam(defaults, "Destination", singleLogoutServiceURL[0]);
        defaults = Utility.defaultParam(defaults, "AuthnRequestID", authnRequestID);
        defaults = Utility.defaultParam(defaults, "NameQualifier", "https://validator.spid.gov.it");
        defaults = Utility.defaultParam(defaults, "Issuer", config_idp.entityID);
        
        let testSuite = new TestSuite(config_idp, config_test);
        let logoutResponse = testSuite.getTestTemplate("test-logout", "1", requestedAttributes, defaults, []);
        let signature = null;

        let idp = new IdP(config_idp);
        let sign_credentials = (logoutResponse.sign_credentials!=null)? 
            logoutResponse.sign_credentials : config_idp.credentials[0];
        let SAMLResponse = logoutResponse.compiled;
        let sigAlg = sign_credentials.signatureAlgorithm;
        let relayState = req.session.request.relayState;

        // defaults
        sign_response = logoutResponse.sign_response;

        if(sign_response) {
            let mode = SIGN_MODE.GET_SIGNATURE;
            let logoutResponsePayload = idp.getLogoutResponsePayload(SAMLResponse, relayState, sigAlg);
            signer = new Signer(sign_credentials);
            signature = signer.sign(logoutResponsePayload, mode); 
        }

        req.session.destroy();

        let url = singleLogoutServiceURL[0];
        let logoutURL = idp.getLogoutResponseURL(url, SAMLResponse, sigAlg, signature, relayState);
        res.redirect(logoutURL);

    } else {
        res.status(400).send("Session not found");
    }          
}

var checkAuthorisation = function(req) {
    let authorised = false;
	let apikey = req.query.apikey;
    if(apikey!=null && apikey == req.session.apikey) {
		authorised = true;
	} else {
		console.log("ERROR check authorisation : " + apikey);
		authorised = false;
	}
	return authorised;
}

var getEntityDir = function(issuer) {
    let ENTITY_DIR = config_dir.DATA + "/" + issuer.normalize();
    if(!fs.existsSync(ENTITY_DIR)) fs.mkdirSync(ENTITY_DIR);
    return ENTITY_DIR;
}




app.use((req, res, next)=> {
    Utility.log(moment().format("YYYY-MM-DD HH:mm:ss") + " - " + req.method + " [" + req.ips.join(' - ') + "] " + req.path);
    next();
});



/* IDP */
require('./app/idp')		    (app, checkAuthorisation, getEntityDir, sendLogoutResponse);
require('./app/auth')		    (app, checkAuthorisation, authenticator, getValidationInfo);

/* API */
require('./api/info')		    (app, checkAuthorisation);
require('./api/store')		    (app, checkAuthorisation, getEntityDir, database);
require('./api/metadata-sp')	(app, checkAuthorisation, getEntityDir, database);
require('./api/request')    	(app, checkAuthorisation, getEntityDir, database);
require('./api/response')    	(app, checkAuthorisation);




// get store info from external code
// only for OnBoarding, protected by AgID Login
app.get("/api/sob/store", function(req, res) {
    res.redirect(authenticator.getAuthURL("store"));
});


// get validation info from external code
// only for OnBoarding, not protected
app.get("/api/sob/validation", function(req, res) {
    //res.redirect(authenticator.getAuthURL("validation"));
    res.send(getValidationInfo(req.query.user, req.query.code));
});

// get metadata info from external code
// only for OnBoarding, not protected
app.get("/api/sob/metadata", function(req, res) {
    //res.redirect(authenticator.getAuthURL("validation"));
    res.send(getMetadataInfo(req.query.code));
});





// start
app.listen(8080, () => {
    // eslint-disable-next-line no-console
    console.log("\nSPID Validator\nversion: 3.0\n\nlistening on port 8080");
});
