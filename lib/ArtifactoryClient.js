/**
 * @overview Module for interacting with Artifactory REST API.
 */

const Path = require('path');
const fetch = require('node-fetch');
const fs = require('fs');
let md5File = require('md5-file');
const { promisify } = require('util');

md5File = promisify(md5File);

function toBase64(str) {
  return (new Buffer(str || '', 'utf8')).toString('base64')
}

/**
 * Creates a new Artifactory client instance
 * @constructs ArtifactoryClient
 * @param {String} url Base url of Artifactory instance (like 'http://localhost:8080/artifactory'). It should contain path if your instance uses it (by default)
 * @param {Object} [options]  Additinal options
 * @param {boolean} [options.strictSSL]
 */
class ArtifactoryClient{

  constructor(url, options = {}) {
    this.url = url.replace(/\/$/, "");
    this.options = options;
  }

  /**
   * Set auth for all subsequent requests.
   * @param {String} auth basic auth (user+password in base64 w/o "Basic ")
   * OR
   * @param {String} login User name
   * @param {String} password User password (plain or encrypted)
   */
  setAuth(user, password) {
    if (password) {
      this.basicHttpAuth = toBase64(user + ":" + password);
    } else {
      this.basicHttpAuth = password;
    }
  }

  /**
   * 
   */
  async getNpmConfig(repoKey, scope) {

    let api;
    if (repoKey && scope) {
      api = ArtifactoryClient.API.getNpmConfigGlobal;
    }else{
      api = ArtifactoryClient.API.getNpmConfigScoped
    }

    const res = await this._fetch(api, {
      repoKey: repoKey,
      scope: scope
    }, options);

    if (!res.ok) {
      throw new Error(res.status);
    }

    return res.text();

  }

  /** 
   * Get common request options for the specified url and optional querystring params.
   * @param {string} actionPath Action relative url 
   * @paran [object] params Optinal querystring params
   */
  getRequestOptions(overwrite = {}) {

    const options = Object.assign({
      headers: {},
    }, overwrite);

    if (this.basicHttpAuth) {
      options.headers['Authorization'] = 'Basic ' + this.basicHttpAuth
    }

    return options;
  }


  /** 
   * Get user encrypted password.
   * See {@link https://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-GetUserEncryptedPassword|Get User Encrypted Password}.
   * @param   {string} login Login name of a Artifactory user
   * @param   {string} password User password to encrypt
   * @returns {object} A Promise to a encrypted password
   */
  async getEncryptedPassword(login, password) {
    const res = await this._fetch(ArtifactoryClient.API.encryptedPassword);
    if(!res.ok){
      throw new Error('Could not get encrypted password');
    }
    return res.text();
  }


  /** 
   * Get file/folder info from Artifactory.
   * @param   {string} path The path to the file/folder inside the repo.
   * @returns {object} A Promise to a json object with the file's info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-FileInfo|FileInfo} Artifactory API.
   */
  async getFileInfo(path) {
    const res = await this._fetch(ArtifactoryClient.API.getFileInfo, {
      path
    });
    
    if (!res.ok) {
      throw new Error(response.statusCode);
    }

    return res.json();
  }

  /** 
   * Get folder info from Artifactory.
   * @param   {string} path The path to the folder inside the repo.
   * @returns {object} A Promise to a json object with the folder's info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-FolderInfo|FolderInfo} Artifactory API.
   */
  getFolderInfo(path) {
    if (path[path.length - 1] !== '/') {
      path = path + '/';
    }
    return this.getFileInfo(path);
  }

  _fetch(api, params, options){
    const url = this.url + api(params);
    options = this.getRequestOptions(options)

    console.log(url);
    return fetch(url, options);
  }

  /**
   * Checks if the file exists.
   * @param   {string} path The path to a file/folder inside the repo.
   * @returns {object} A Promise to a boolean value
   */
  async isPathExists(path) {
    const res = await this._fetch(ArtifactoryClient.API.filePath, {
      path
    }, { method: 'HEAD' });

    return res.ok
  }

  /**
   * Uploads a file to artifactory. The uploading file needs to exist!
   * @param   {string} path The path to the file inside the repo. (in the server)
   * @param   {string} fileToUploadPath Absolute or relative path to the file to upload.
   * @param   {boolean} [forceUpload=false] Flag indicating if the file should be upload if it already exists.
   * @returns {object} A Promise to a json object with creation info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-DeployArtifact|DeployArtifact} Artifactory API.
   */
  async uploadFile(path, fileToUploadPath, forceUpload = false) {

    const isRemote = !!fileToUploadPath.match(/^https?:\/\//i);
    const fileToUpload = isRemote ? fileToUploadPath : Path.resolve(fileToUploadPath);

    // Check the file to upload does exist! (if local)
    if (!isRemote && !fs.existsSync(fileToUpload)) {
      throw new Error(`The file to upload ${fileToUpload} does not exist`);
    }

    //Check if file exists..
    const fileExists = await this.isPathExists(path)

    if (fileExists && !forceUpload) {
      throw new Error('File already exists and forceUpload flag was not provided with a TRUE value.');
    }

    const stream = isRemote ? fetch(fileToUpload) : fs.createReadStream(fileToUpload);

    //In any other case then proceed with *upload*
    const res = await this._fetch(ArtifactoryClient.API.filePath, {
      path
    }, {
      method: 'PUT',
      body: stream
    });

    if (!res.ok) {
      throw new Error(`HTTP Status Code from server was: ${ res.status }`);
    }

    return res.json();
  }

  /** 
   * Downloads an artifactory artifact to a specified file path. The folder where the file will be created MUST exist.
   * @param   {string} path The path to the file inside the repo. (in the server)
   * @param   {string} destinationFile Absolute or relative path to the destination file. The folder that will contain the destination file must exist.
   * @param   {boolean} [checkChecksum=false] A flag indicating if a checksum verification should be done as part of the download.
   * @returns {object} A Promise to a string containing the result.
   */
  async downloadFile(path, destinationFile, checkFileIntegrity = false) {

    const destinationPath = Path.resolve(destinationFile);

    if (!fs.existsSync(Path.dirname(destinationPath))) {
      throw new Error(`The destination folder ${ Path.dirname(destinationPath) } does not exist.`);
    }

    const res = await this._fetch(ArtifactoryClient.API.filePath, {
      path
    });

    if(!res.ok){
      throw new Error(`Could not download file: ${ res.status }`)
    }

    const stream = fs.createWriteStream(destinationPath)
    const streamWaiter = new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    res.body.pipe(stream);
    
    await streamWaiter

    if (checkFileIntegrity) {
      const fileInfo = await this.getFileInfo(path);
      const checkSum = await md5File(destinationPath);
      if (checkSum !== fileInfo.checksums.md5) {
        throw new Error(`Error downloading file ${ options.url }. Checksum (MD5) validation failed. Expected: ${ fileInfo.checksums.md5 } - Actual downloaded: ${ checkSum }`)
      }
    }
  }

  /** 
   * Downloads an artifactory folder as zip archive to a specified file path. The folder where the local file will be created MUST exist.
   * @param   {string} repoKey  The key of the repo.
   * @param   {string} remotePath The path to a folder inside the repo.
   * @param   {string} destinationFile Absolute or relative path to a local file. The folder that will contain the destination file must exist.
   * @param   {string} [archiveType] Optional archive type, by default - 'zip'.
   * @returns {object} A Promise to a string containing the result.
   */
  async downloadFolder(path, destinationFile, archiveType = 'zip') {
    const destinationPath = Path.resolve(destinationFile);

    if (!fs.existsSync(Path.dirname(destinationPath))) {
      throw new Error(`The destination folder ${Path.dirname(destinationPath)} does not exist.`);
    }

    const res = await this._fetch(ArtifactoryClient.API.downloadFolder, {
      path,
      archiveType
    });

    const stream = fs.createWriteStream(destinationPath);
    const streamWaiter = new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    res.body.pipe(stream);
    
    await streamWaiter
  }


  /** 
   * Create a folder in artifactory.
   * @param   {string} path The path to a folder inside the repo to create.
   * @returns {object} A Promise to a string containing the result.
   */
  async createFolder(path) {

    if (path[path.length - 1] !== '/') {
      path = path + '/';
    }

    const res = await this._fetch(ArtifactoryClient.API.filePath, {
      path
    }, { method: 'PUT' });

    if (!res.ok) {
      throw new Error(`Could not create folder: ${res.status}`)
    } 

    return res.text();
  }


  /** 
   * Delete a folder in artifactory.
   * @param   {string} path The path to a folder inside the repo to delete.
   * @returns {object} A Promise to a string containing the result.
   */
  deleteFolder(path) {
    if (path[path.length - 1] !== '/') {
      path = path + '/';
    }
    return this._deletePath(path);
  }


  /** 
   * Delete a file in artifactory.
   * @param   {string} path The path to a file inside the repo to delete.
   * @returns {object} A Promise to a string containing the result.
   */
  deleteFile(path) {
    return this._deletePath(path);
  }

  /** 
   * Delete a path in artifactory.
   * @param   {string} path The path inside the repo to delete. It can be file or folder (ends with '/').
   * @returns {object} A Promise to a string containing the result.
   */
  async _deletePath(path) {
    const res = await this._fetch(ArtifactoryClient.API.filePath, {
      path
    }, {method: 'DELETE'});

    if(!res.ok){
      throw new Error(res.status)
    }

    return res.text();
  }


  /**
   * Move a file or folder to a new path (or rename).
   * If the target path does not exist, the source item is moved and optionally renamed. 
   * Otherwise, if the target exists and it is a directory, the source is moved and placed under the target directory.
   * @param   {string}  srcRepoKey  The key of the repo where the file is stored.
   * @param   {string}  srcPath The path to the file/dir inside the repo.
   * @param   {string}  dstRepoKey  The key of the repo where the file/dir will be moved.
   * @param   {string}  srcPath The path to the file/dir to move: if it's file .
   * @param   {boolean} [dryrun] true for test the move (no actual move will happen)
   */
  async moveItem(srcPath, dstPath, dryrun) {

    // if dstPath is folder (ends with '/') then for move to works (not rename) it should exist or it should be file name
    // For example we're moving ("repo", "path/to/filepath.ext", "repo", "path/to/new/").
    // If folder 'new' doesn't exist then file "path/to/filepath.ext" will be renamed to "path/to/new",
    // In the most cases it's not we want. So try to create the folder first. 
    // We don't care about existence - we'll get an errpr and continue
    if (dstPath[dstPath.length - 1] === '/') {
      try {
        await this.createFolder(dstPath)
      }catch(e){}
    }

    // it's a rename (path/file -> newpath/newfile)
    return this._moveItem(srcPath, dstPath, dryrun);

  }

  async _moveItem(srcPath, dstPath, dryrun) {

    const res = await this._fetch(ArtifactoryClient.API.moveItem, {
      srcPath,
      dstPath,
      dry: dryrun
    }, {method: 'POST'})

    if(!res.ok){
      throw new Error(res.status);
    }

    return res.text();
  }


  /**
   * Move a bunch of files to a new path.
   * @param   {string}   srcPath The path to the source dir inside the repo.
   * @param   {Function} filterCb Callback to filter source files. Only files to conform filter will be moved. NOTE: filtering is conducted on the client, not server.
   * @param   {string}   dstPath The path to a dir to move files into.
   * @param   {boolean}  [dryrun] true for test the move (no actual move will happen)
   */
  async moveItems(srcPath, filterCb, dstPath, dryrun) {
    if (srcPath[srcPath.length - 1] !== '/') {
      srcPath += '/';
    }

    if (dstPath[dstPath.length - 1] !== '/') {
      dstPath += '/';
    }

    // get source folder content
    const result = await this.getFolderInfo(srcPath)
    if (!result.children) {
      throw new Error(`No files in ${ srcPath }`);
    }

    try {
      await this.createFolder(dstPath)
    } catch (error) {}

    const allItems = result.children.filter(i => !item.folder && item.uri);
    const filesToMove = allItems.filter(item => (!filterCb ||
      filterCb(item.uri.substring(item.uri.lastIndexOf('/') + 1))
    ));

    console.log(`Start moving ${ totalToMove.length } files to ${ dstPath } (candidate count: ${ allItems.length })`);

    const promises = filesToMove.map(item => {
      console.log(`Moving ${ item.uri } into ${ dstPath }`);
      return this._moveItem(srcPath + item.uri, dstPath, dryrun)
    })

    await Promise.all(promises);

  }

}

/**
 * @prop {object} ACTIONS - The ACTIONS listed here represent well-known paths for
 * common artifactory actions.
 * @static
 */
ArtifactoryClient.API = {
  encryptedPassword: () => `/api/security/encryptedPassword`,
  filePath: ({path}) => '/'+path,
  getFileInfo: ({
    path
  }) => `/api/storage/${ path }`,
  downloadFolder: ({
    path,
    archiveType
  }) => `/api/archive/download/${ path }?archiveType=${archiveType}`,
  moveItem: ({
    srcPath,
    dstPath,
    dry = false
  }) => `/api/move/${ srcPath }?to=/${ dstPath }?dry=${dry}`,
  getNpmConfigGlobal: () => `/api/npm/auth`,
  getNpmConfigScoped: ({
    repoKey,
    scope
  }) => `/api/npm/${ repoKey }/auth/${ scope }`
};


module.exports = ArtifactoryClient;