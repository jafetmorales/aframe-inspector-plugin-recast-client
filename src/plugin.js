const Handlebars = require('handlebars');
const RecastConfig = require('./recast-config');
const panelTpl = require('./plugin.html');
const GeometryReducer = require('./three-geometry-reducer');
const OBJExporter = require('../lib/OBJExporter');
require('./components/nav-debug-pointer');
require('./plugin.scss');

////CROSSTAB
// import AWS object without services
var AWS = require('aws-sdk/global');
// import individual service
var S3 = require('aws-sdk/clients/s3');
const dbFirebase = require('./FirebaseApp.js')
var firebase = require('firebase');

var $ = require( "jquery" );

class RecastError extends Error {}
/**
 * Recast navigation mesh plugin.
 */
class RecastPlugin {
  constructor(panelEl, sceneEl, host, expiration) {
    this.panelEl = panelEl;
    this.sceneEl = sceneEl;
    this.spinnerEl = panelEl.querySelector('.recast-spinner');
    this.settings = {};
    this.navMesh = null;
    this.host = host;
    this.bindListeners();
    this.url=""

    ////CROSSTAB
    this.expiration = expiration
    this.dbFirebase = dbFirebase
    this.user = firebase.auth().currentUser;
    AWS.config.region = 'us-east-2';
    AWS.config.credentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: 'us-east-2:dfec3483-aade-48a4-b2d1-40a142000817',
      Logins: {
        'cognito-identity.amazonaws.com': window.COGNITO_TOKEN
      }
    });
    this.bucketName = 'tensor-objects'
    this.s3 = new S3({
      apiVersion: '2006-03-01',
      params: { Bucket: this.bucketName }
    });
  }

  /** Attach event listeners to the panel DOM. */
  bindListeners() {
    const settings = this.settings;

    // Update labels when sliders change.
    RecastConfig.forEach(({ name }) => {
      const input = this.panelEl.querySelector(`input[name=${name}]`);
      settings[name] = input.value;
      input.addEventListener('input', () => {
        settings[name] = Number(input.value);
      });
    });

    // Rebuild.
    const rebuildBtnEl = this.panelEl.querySelector('[name=build]');
    rebuildBtnEl.addEventListener('click', () => this.rebuild());

    // Export.
    const exportBtnEl = this.panelEl.querySelector('[name=export]');
    exportBtnEl.addEventListener('click', () => this.exportGLTF());
  }

  /**
   * Convert the current scene to an OBJ, rebuild the navigation mesh, and show
   * a preview of the navigation mesh in the scene.
   */
  rebuild() {
    
    console.log('about to validate form')
    this.validateForm();

    this.clearNavMesh();
    console.log('about to serialize scene')
    const body = this.serializeScene();
    console.log('about to get three objloader')
    const loader = new THREE.OBJLoader();
    const params = this.serialize(this.settings);

    this.showSpinner();
    console.log('about to try to fetch mesh')
    fetch(`${this.host}/v1/build/?${params}`, { method: 'post', body: body })
      .then((response) => response.json())
      .then((json) => {
        if (!json.ok) throw new RecastError(json.message);

        const navMeshGroup = loader.parse(json.obj);
        const meshes = [];

        navMeshGroup.traverse((node) => {
          if (node.isMesh) meshes.push(node);
        });

          console.log('got this number of meshes')
          console.log(meshes.length)

        if (meshes.length !== 1) {
          console.warn('[aframe-inspector-plugin-recast] Expected 1 navmesh but got ' + meshes.length);
          if (meshes.length === 0) return;
        }

        if (this.navMesh) this.sceneEl.object3D.remove(this.navMesh);

        this.navMesh = meshes[0];
        console.log('this.navMesh is')
        console.log(this.navMesh)
        this.navMesh.material = new THREE.MeshNormalMaterial();
        ////
        // this.injectNavMesh(this.navMesh);

        // Delay resolving, so first render blocks hiding the spinner.
        return new Promise((resolve) => setTimeout(resolve, 30));
      })
      .catch((e) => {
        console.error(e);
        e instanceof RecastError
          ?
          window.alert(e.message) :
          window.alert('Oops, something went wrong.');
      })
      .then(() => {
        this.hideSpinner()
        this.exportGLTF()

        this.uploadNavMesh()
        // console.log('returned url is')
        // console.log(this.url)
        
        ////
        // this.injectNavMesh(this.navMesh,this.url);
      });
  }

  /** Validate all form inputs. */
  validateForm() {
    const form = this.panelEl.querySelector('.panel-content');
    if (!form.checkValidity()) {
      this.fail('Please correct errors navmesh configuration.');
    }
  }

  /**
   * Collect all (or selected) objects from scene.
   * @return {FormData}
   */
  serializeScene() {
    const selector = 'A-GRID,A-RING,a-entity:not(.exclude_from_nav_mesh):not(#camera2):not(.environment):not(A-SKY):not(#stars):not([nav-mesh])'

    this.sceneEl.object3D.updateMatrixWorld();
    this.markInspectorNodes();

    const reducer = new GeometryReducer({ ignore: /^[XYZE]+|picker$/ });

    if (selector) {
      const selected = this.sceneEl.querySelectorAll(selector);
      const visited = new Set();

      [].forEach.call(selected, (el) => {
        if (!el.object3D)
        {
          console.log('not a 3d object')
          return
        };
          console.log('yes a 3d object, about to traverse')
        el.object3D.traverse((node) => {
          if (visited.has(node)) return;
          reducer.add(node);
          visited.add(node);
        });
      });
    }
    else {
      this.sceneEl.object3D.traverse((o) => reducer.add(o));
    }

    console.info('Pruned scene graph:');
    this.printGraph(reducer.getBuildList());

    console.info('About to reduce');
    const { position, index } = reducer.reduce();

    // Convert vertices and index to Blobs, add to FormData, and return.
    console.log('doing blob 1')
    const positionBlob = new Blob([new Float32Array(position)], { type: 'application/octet-stream' });
    console.log('doing blob 2')
    const indexBlob = new Blob([new Int32Array(index)], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('position', positionBlob);
    formData.append('index', indexBlob);
    return formData;
  }

  /**
   * Attempt to pre-mark inspector-injected nodes. Unfortunately
   * there is no reliable way to do this; we have to assume the first
   * object named 'picker' is one of them, walk up the tree, and mark
   * everything below its root.
   */
  //////THIS WAS MODIFIED BY JAFET
  ///YOU SHOULD BE MARKING THE PLAYER SO THAT HE IS NOT EVALUATED BY THE PLUGIN AS PART OF THE ARCHITECTURE
  markInspectorNodes() {
    // const scene = this.sceneEl.object3D;
    // let inspectorNode = scene.getObjectByName('picker');
    // while (inspectorNode.parent !== scene) inspectorNode = inspectorNode.parent;
    // inspectorNode.traverse((node) => {
    //   node.userData._isInspectorNode = true;
    // });
  }

  /**
   * Injects navigation mesh into the scene, creating entity if needed.
   * @param  {THREE.Mesh} navMesh
   */
  injectNavMesh(navMesh,url) {
    //WE LOOK TO SEE IF THERE ARE ANY NAV MESHES ALREADY IN THE SCENE
    
    
    //THIS REMOVAL SHOULD BE DONE ONLY IN THE DOM, AND A REMOVAL MUTATION LISTENER IN TRAINMAN SHOULD FIX FIREBASE AUTOMATICALLY SO YOU NEED TO IMPLEMENT THAT!!!
        //   this.dbFirebase.ref("users").child(this.user.uid).child("currentWorld").once("value").then(function(snapshot) {
        //   this.user.currentWorld = snapshot.toJSON();
        //   this.dbFirebase.ref("worlds").child(this.user.uid).child(this.user.currentWorld).child("entities").child(this.sceneEl.querySelector('[nav-mesh]').getAttribute('id')).remove();
        // }.bind(this))
    // $("[nav-mesh]").remove();


    // // navMeshEl.forEach()
    // if(navMeshEl)
    // {
    //   navMeshEl.parentNode.removeChild(navMeshEl);
    // }
    // else
    // {


    let navMeshEl = this.sceneEl.querySelector('[nav-mesh]');
    if (!navMeshEl) {
      navMeshEl = document.createElement('a-entity');
    }
    console.log('injecting mesh from')
    console.log(url)
      navMeshEl.setAttribute('nav-mesh', 'DUMMY_STRING_BRO');
      // navMeshEl.setAttribute('id', Date.now());
      //commented line below because it is pointless since the class gets replaced by react
      navMeshEl.setAttribute('class', 'exclude_from_nav_mesh');
      navMeshEl.setAttribute('visible', 'true');
      navMeshEl.setAttribute('position', document.getElementById('enclosure').object3D.position);
      navMeshEl.setAttribute('color','#EF2D5E')
      navMeshEl.setAttribute('opacity', '.5');
      navMeshEl.setAttribute('scale', '1 1 1');
      // navMeshEl.setAttribute('rotation', '1 1 1');


      // navMeshEl.setAttribute('wireframe', 'true');
      // navMeshEl.setAttribute('wireframe', 'dummyValue');
      // navMeshEl.setAttribute('material', 'vertexColors:face;opacity:.5;wireframe:true;');

      navMeshEl.setAttribute('gltf-model', "url(" + url + ")");
      
      // navMeshEl.setAttribute('material',"side: double; color: #EF2D5E; transparent: false; opacity: 0.5")
      
      this.sceneEl.appendChild(navMeshEl);
    // }
    
    setTimeout(() => {
      navMeshEl.setObject3D('mesh', navMesh);
      const navMeshComponent = navMeshEl.components['nav-mesh'];
      if (navMeshComponent) navMeshComponent.loadNavMesh();
    }, 20);
  }

  /** Removes navigation mesh, if any, from scene. */
  clearNavMesh() {
    const navMeshEl = this.sceneEl.querySelector('[nav-mesh]');
    if (navMeshEl) navMeshEl.removeObject3D('mesh');
  }

  /** Export to glTF 2.0. */
  exportGLTF() {
    if (!this.navMesh) throw new Error('[RecastPlugin] No navigation mesh.');
    const exporter = new THREE.GLTFExporter();
    const backupMaterial = this.navMesh.material;
    this.navMesh.material = new THREE.MeshStandardMaterial({ color: 0x808080, metalness: 0, roughness: 1 });
    exporter.parse(this.navMesh, (gltfContent) => {
      this.navMesh.material = backupMaterial;
      //UNCOMMENTED 1/27/2021
      this._download('navmesh.gltf', JSON.stringify(gltfContent));
    }, { binary: false });
  }

  /** Export to OBJ. */
  exportOBJ() {
    if (!this.navMesh) throw new Error('[RecastPlugin] No navigation mesh.');
    const exporter = new OBJExporter();
    this._download('navmesh.obj', exporter.parse(this.navMesh));
  }

  /** Upload nav mesh. */
  uploadNavMesh() {
    if (!this.navMesh) throw new Error('[RecastPlugin] No navigation mesh.');
    const exporter = new THREE.GLTFExporter();
    const backupMaterial = this.navMesh.material;
    this.navMesh.material = new THREE.MeshStandardMaterial({ color: 0x808080, metalness: 0, roughness: 1 });
    exporter.parse(this.navMesh, (gltfContent) => {
      this.navMesh.material = backupMaterial;
      
      ////CROSSTAB
      const data = JSON.stringify(gltfContent)
      const fileName = 'navmesh' + (new Date().getTime())
      const cognitoIdentityId = AWS.config.credentials.identityId
      var folderKey = 'navs/' + cognitoIdentityId + '/' + 'navmesh_' + (new Date().getTime()) + '.gltf'
      this.s3.upload({
        // this.s3.getSignedUrl('putObject', {
        Bucket: this.bucketName,
        Key: folderKey,
        ContentType: 'data:text/plain;charset=utf-8',
        Body: data,
        ACL: 'private' //OTHER TYPES OF ACLS THAT ARE MORE PUBLIC SHOULD THROW BACK AN UNAUTHORIZED ERROR
        //   ,
        // ContentMD5: 'false',
        // Expires: 604800
        // }, function(err, data) {
      }, function(err, url) {
        if (err) {
          return alert('There was an error creating your album: ' + err.message);
        }
        var params = { Bucket: this.bucketName, Key: folderKey, Expires: this.expiration };
        this.url = this.s3.getSignedUrl('getObject', params);
        this.injectNavMesh(this.navMesh,this.url);

        
        // console.log('the url to be returned is')
        // console.log(url)        
            
////        
      //   this.dbFirebase.ref("users").child(this.user.uid).child("currentWorld").once("value").then(function(snapshot) {
      //     this.user.currentWorld = snapshot.toJSON();
      //     this.dbFirebase.ref("worlds").child(this.user.uid).child(this.user.currentWorld).child("entities").child(this.sceneEl.querySelector('[nav-mesh]').getAttribute('id')).child('gltf-model').set("url(" + url + ")").then(function() {})
      //   }.bind(this))
      }.bind(this));
    ////CROSSTAB ENDS HERE
    
    }, { binary: false });
  }

  /**
   * Start a nav mesh download from the user's browser.
   * @param  {string} filename
   * @param  {string} content
   */
  _download(filename, content) {
    const el = document.createElement('a');
    el.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(content));
    el.setAttribute('download', filename);
    el.style.display = 'none';

    document.body.appendChild(el);
    el.click();
    document.body.removeChild(el);
  }

  /**
   * Prints debug graph of a scene subtree.
   * @param  {THREE.Object3D} node
   */
  printGraph(node) {

    console.group(' <' + node.type + '> ' + node.name);
    node.children.forEach((child) => this.printGraph(child));
    console.groupEnd();

  }

  /**
   * Converts an object to URI query parameters.
   * @param  {Object<string, *>} obj
   * @return {string}
   */
  serialize(obj) {
    const str = [];
    for (let p in obj) {
      if (obj.hasOwnProperty(p)) {
        str.push(encodeURIComponent(p) + '=' + encodeURIComponent(obj[p]));
      }
    }
    return str.join('&');
  }

  /**
   * Sets visibility of the plugin panel.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this.panelEl.style.display = visible ? '' : 'none';
  }

  /** Shows the loading spinner. */
  showSpinner() {
    this.spinnerEl.classList.add('active');
  }

  /** Hides the loading spinner. */
  hideSpinner() {
    this.spinnerEl.classList.remove('active');
  }

  /**
   * Displays a user-facing message then throws an error.
   * @param {string} msg
   */
  fail(msg) {
    window.alert(msg);
    throw new Error(msg);
  }
}

/**
 * Plugin component wrapper.
 *
 * The A-Frame Inspector does not technically have a plugin
 * API, and so we use this component to detect events (play/pause) indicating
 * that the inspector is (probably) opened or closed.
 */
AFRAME.registerComponent('inspector-plugin-recast-client', {
  schema: {
    serviceURL: { default: 'https://recast-api.donmccurdy.com' },
    linkExpiration: { default: 604800 },
    interval: { default: 30 }
  },
  init: function() {
    const wrapEl = document.createElement('div');
    const template = Handlebars.compile(panelTpl);
    wrapEl.innerHTML = template({ RecastConfig: RecastConfig });
    const panelEl = wrapEl.children[0];
    document.body.appendChild(panelEl);
    this.plugin = new RecastPlugin(panelEl, this.el, this.data.serviceURL, this.data.linkExpiration);
  },
  pause: function() {
    // this.plugin.setVisible(true);
    console.log('ABOUT TO CLEAR THE INTERVAL')
    clearInterval(this.rebuildIntervalId)
  },
  play: function() {
    //THIS IS FOR SHOWING THE PANEL THAT COMES WITH THE RECAST APP
    // this.plugin.setVisible(false);

    this.rebuildIntervalId = setInterval(function() {
      console.log('this.render is::::')
      console.log(this.render)
      // this.plugin.rebuild() 
      this.render()
    }.bind(this), this.data.interval * 1000);


  },
  render: function() {
    this.plugin.rebuild()
  },
  remove: function() {
    console.log('ABOUT TO CLEAR THE INTERVAL')
    clearInterval(this.rebuildIntervalId)
  }

});
