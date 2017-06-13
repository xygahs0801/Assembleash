
import React, { Component }  from "react"
import PropTypes             from 'prop-types'
import ReactDOM              from "react-dom"
import SplitPane             from 'react-split-pane'
import Script                from 'react-load-script'
import { NotificationStack } from 'react-notification'
import { throttle }          from 'throttle-debounce'
import FileSaver             from 'file-saver'

import ToolbarContainer from './ToolbarContainer'
import Editor           from '../Components/Editor'
import Footer           from '../Components/Footer'

import {
    isRequreStdlib,
    getCompilerVersion,
    CompilerDescriptions,
    CompileModes,
    formatCode,
    formatSize
} from '../Common/Common'

import { OrderedSet } from 'immutable'

const input =
`export function fib(num: int32): int32 {
    if (num <= 1) return 1;
    return fib(num - 1) + fib(num - 2);
}`;


const AutoCompilationDelay = 800; //ms
const MaxPrintingErrors = 8;

export default class EditorContainer extends Component {
    static defaultProps = {
        compiler: 'AssemblyScript'
    }

    static propTypes = {
        compiler: PropTypes.string
    }

    constructor(props) {
         super(props);
         this.state = {
             version:           '0.0.1',
             compiler:          props.compiler,
             compileMode:       CompileModes[0],
             compilerReady:     false,
             compileFailure:    false,
             compileSuccess:    false,
             inputEditorWidth:  '100%',
             outputEditorWidth: '100%',
             editorsHeight:     '750px',
             output: {
                 text:   '',
                 binary: null
             },
             outputType:        'text',

             // settings
             validate:          true,
             optimize:          true,
             stdlib:            false,
             longMode:          false,

             annotations:       OrderedSet(),
             notifications:     OrderedSet(),
             notificationCount: 0
         };

         this._errorCounts       = 0;
         this._lastTextInput     = input.trim();
         this._compileTimerDelay = null;
         this._cachedClientRect  = null;
    }

    componentDidMount() {
        this.updateWindowDimensions();
        window.addEventListener("resize", this.updateWindowDimensions);
    }

    componentWillUnmount() {
        window.removeEventListener("resize", this.updateWindowDimensions);
    }

    updateWindowDimensions = () => {
        this._cachedClientRect = null;
        this.handleSize();
    }

    _clearCompileTimeout() {
        this._compileTimerDelay && clearTimeout(this._compileTimerDelay);
        this._compileTimerDelay = null;
    }

    updateCompilationWithDelay = (delay = 5000) => {
        this._clearCompileTimeout();
        this._compileTimerDelay = setTimeout(() => {
            this.updateCompilation();
            this._compileTimerDelay = null;
        }, delay);
    }

    updateCompilation = () => {
        if (!this.inputEditor) return;

        this.removeAllNotification();
        this.removeAllAnnotation();

        let stdlib = this.state.stdlib;
        const { compiler, validate, optimize, longMode } = this.state;
        const inputCode = this.inputEditor.state.value;

        if (this.toolbar && this.toolbar.compileButton) {
            this._errorCounts = 0;
            this.toolbar.compileButton.startCompile();
            this.setState({
                compileSuccess: false,
                compileFailure: false
            });
        }

        setImmediate(() => {
            if (!stdlib && isRequreStdlib(inputCode)) {
                stdlib = true;
                //this.setState({ stdlib });
            }

            setImmediate(() => {
                try {
                    if (compiler === 'AssemblyScript') {
                        this.compileByAssemblyScript(inputCode, { stdlib, validate, optimize, longMode });
                    } else if (compiler === 'TurboScript') {
                        this.compileByTurboScript(inputCode);
                    } else {
                        console.warn('Compiler not supported');
                    }
                } catch (e) {
                    this.setState({
                        compileSuccess: false,
                        compileFailure: true
                    });

                    this._errorCounts = 1;

                    let message = '<' + compiler + '> internal error:\n';
                    this.addNotification(message + e.message);
                    console.error(message, e);

                } finally {
                    if (this.toolbar && this.toolbar.compileButton)
                        this.toolbar.compileButton.endCompile();
                }
            });
        });
    }

    compileByAssemblyScript(code, { stdlib, validate, optimize, longMode }) {

        const as = window.assemblyscript;
        var module = as.Compiler.compileString(code, { silent: true, uintptrSize: longMode ? 8 : 4, noLib: !stdlib });

        setImmediate(() => {
            if (!module) {
                this.setState({
                    compileSuccess: false,
                    compileFailure: true
                });

                const diagnostics = as.Compiler.lastDiagnostics;
                this._errorCounts = diagnostics.length;

                for (let i = 0; i < diagnostics.length; i++) {
                    let errorMessage = as.typescript.formatDiagnostics([diagnostics[i]]);

                    if (i <= MaxPrintingErrors) {
                        console.error(errorMessage);
                        this.addNotification(errorMessage);
                        this.addAnnotation(errorMessage);
                    } else {
                        errorMessage = `Too many errors (${diagnostics.length})`;
                        console.error(errorMessage);
                        this.addNotification(errorMessage);
                        break;
                    }
                }

            } else {
                setImmediate(() => {
                    if (validate)
                        module.validate();

                    if (optimize)
                        module.optimize();

                    this._errorCounts = 0;

                    setImmediate(() => {
                        this.setState({
                            compileSuccess: true,
                            compileFailure: false,

                            output: {
                                text:   module.emitText(),
                                binary: module.emitBinary()
                            }
                        });

                        module.dispose();
                    });
                });
            }
        });
    }

    compileByTurboScript(code, options) {
        // TODO
    }

    onInputChange = value => {
        // skip compilation if possible
        value = value.trim();
        if (this._lastTextInput === value) {
            return;
        }

        this._lastTextInput = value;
        const mode = this.state.compileMode;

        if (mode === CompileModes[0]) { // Auto
            this.updateCompilationWithDelay(AutoCompilationDelay);
        }
    }

    onDownloadBinary = () => {
        const { output, compiler } = this.state;
        var blob = new Blob([output.binary], { type: "application/octet-stream" });
        FileSaver.saveAs(blob, `${compiler.toLowerCase()}.module.wasm`);
    }

    onScriptLoad = () => {
        this.setState({
            compilerReady: true,
            version: getCompilerVersion(this.state.compiler)
        });

        this.updateCompilation();
    }

    onScriptError = () => {
        console.error('Script not load');
        this.setState({
            compilerReady: false
        });
    }

    onSplitPositionChange = size => {
        this.handleSize(size);
    }

    onCompileButtonClick = mode => {
        this._clearCompileTimeout();

        if (mode === CompileModes[0] || // Auto
            mode === CompileModes[1]) { // Manual

            this.updateCompilation();

        } else if (CompileModes[2]) {
            // Decompile not supported yet
        }
    }

    onSettingsOptionChange = (key, value) => {
        if (!this.state.compilerReady) return;
        this.setState({ [key]: value }, this.updateCompilation );
    }

    handleSize = throttle(8, size => {
        if (this.splitEditor) {
            if (!this._cachedClientRect) {
                this._cachedClientRect = ReactDOM.findDOMNode(this.splitEditor).getBoundingClientRect();
            }
            const { width, height } = this._cachedClientRect;
            const gripWidth = 4;

            this.setState({
                inputEditorWidth:  size ? size : '100%',
                outputEditorWidth: size ? width - size - gripWidth : '100%',
                editorsHeight:     height - 160
            });
        }
    })

    addNotification = (message) => {
        // skip notifications for Auto compile mode
        if (this.state.compileMode === CompileModes[0]) { //Auto
            return;
        }

    	const { notifications, notificationCount } = this.state;

        const id = notifications.size + 1;
        const newCount = notificationCount + 1;
        return this.setState({
        	notificationCount: newCount,
        	notifications: notifications.add({
                id,
        		message,
        		key: newCount,
        		action: '✕',
        		dismissAfter: 5000,
                actionStyle: {
                    borderRadius: 0,
                    paddingLeft: '1.5rem',
                    paddingRight: '0.6rem',
                    fontSize: '1.8rem',
                    color: '#fff'
                },
        		onClick: () => this.removeAllNotification()
        	})
        });
    }

    addAnnotation = (message, type = 'error') => {
        const rowRegex = /\(([^)]+)\)/;
        const matches = rowRegex.exec(message);
        if (matches && matches.length === 2) {
            var row = ((matches[1].split(','))[0] >>> 0) - 1;
            let annotations = this.state.annotations;
            this.setState({ annotations:
                annotations.add({ row, type, text: message })
            });
        }
    }

    removeAllAnnotation = () => {
        this.setState({ annotations: OrderedSet() });
    }

    removeNotification = index => {
        const { notifications } = this.state;
        return this.setState({
            notifications: notifications.filter(n => n.key !== index)
        })
    }

    removeAllNotification = () => {
        return this.setState({
            notificationCount: 0,
            notifications: OrderedSet()
        });
    }

    render() {
        const {
            version,
            compiler,

            compilerReady,
            compileSuccess,
            compileFailure,
            notifications,
            annotations,

            inputEditorWidth,
            outputEditorWidth,
            editorsHeight,

            output,
            outputType

        } = this.state;

        function notificationStyle(index, style, notification) {
            return {
                zOrder: 999,
                color: '#fff',
                background: '#f00',
                fontSize: '1.5rem',
                padding: '1.6rem',
                paddingLeft: '2.1rem',
                borderRadius: 0,
                left: '74px',
                bottom: `${6.6 + (index * 5)}rem`
            };
        }

        const errorNotifications = notifications ? (<NotificationStack
            activeBarStyleFactory={ notificationStyle }
            notifications={ notifications.toArray() }
            onDismiss={ notification => this.setState({
                notifications: this.state.notifications.delete(notification)
            }) }
        />) : null;

        const canBinaryDownload   = compilerReady && compileSuccess && output.binary;
        const compilerDescription = CompilerDescriptions[compiler];

        const compilerScript = (compilerDescription ? <Script
            url={ compilerDescription.url }
            onError={ this.onScriptError }
            onLoad={ this.onScriptLoad }
        /> : null);

        let busyState = 'busy';

        if (compilerReady) {
            if (!compileSuccess && compileFailure) {
                busyState = 'failure';
            } else if (compileSuccess && !compileFailure) {
                busyState = 'success';
            }
        }

        return (
            <div>
                { compilerScript }

                <ToolbarContainer
                    ref={ self => this.toolbar = self }
                    version={ version }
                    compiler={ compiler }
                    compileDisabled={ !compilerReady }
                    onCompilerChange={ compiler => this.setState({ compiler }) }
                    onCompileClick={ this.onCompileButtonClick }
                    onCompileModeChange={ mode => {
                        this._clearCompileTimeout();
                        this.setState({ compileMode: mode });
                        if (mode === CompileModes[0]) { // Auto
                            this.updateCompilationWithDelay(AutoCompilationDelay);
                        }
                    }}
                    onSettingsOptionChange={ this.onSettingsOptionChange }
                    onOutputSelect={ type => this.setState({ outputType: type }) }
                />

                <SplitPane
                    ref={ self => this.splitEditor = self }
                    split="vertical"
                    minSize={ 200 }
                    defaultSize="62%"
                    onChange={ this.onSplitPositionChange }
                    style={{
                        margin: '12px'
                    }}
                >
                    <Editor
                        focus
                        id="input"
                        ref={ self => this.inputEditor = self }
                        width={ inputEditorWidth }
                        height={ editorsHeight }
                        code={ input }
                        annotations={ annotations.toArray() }
                        onChange={ this.onInputChange }
                    >
                    </Editor>
                    <Editor
                        readOnly
                        id="output"
                        ref={ self => this.outputEditor = self }
                        width={ outputEditorWidth }
                        height={ editorsHeight }
                        code={ formatCode(output[outputType]) }
                    />
                </SplitPane>

                <Footer
                    errorCount={ this._errorCounts }
                    busyState={ busyState }
                    binarySize={ output.binary ? formatSize(output.binary.length) : '' }
                    onDownloadPressed={ this.onDownloadBinary }
                    downloadDisabled={ !canBinaryDownload }
                />

                { errorNotifications }
            </div>
        );
    }
}
