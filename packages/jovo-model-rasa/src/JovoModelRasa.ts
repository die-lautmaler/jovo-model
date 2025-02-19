import {
  JovoModelRasaData,
  RasaNluData,
  RasaCommonExample,
  RasaEntitySynonym,
  RasaLookupTable,
} from '.';

import {
  InputType,
  InputTypeValue,
  Intent,
  IntentInput,
  JovoModel,
  JovoModelData,
  NativeFileInformation,
} from 'jovo-model';

import * as JovoModelRasaValidator from '../validators/JovoModelRasaData.json';

import * as _ from 'lodash';

export interface InputTypeNameUsedCounter {
  [key: string]: number;
}

export class JovoModelRasa extends JovoModel {
  static MODEL_KEY = 'rasa';

  static toJovoModel(inputFiles: NativeFileInformation[], locale: string): JovoModelData {
    const inputData = inputFiles[0].content;

    const jovoModel: JovoModelData = {
      invocation: '',
      intents: [],
      inputTypes: [],
    };

    const intentDirectory: {
      [key: string]: Intent;
    } = {};

    const synonymDirectory: {
      [key: string]: RasaEntitySynonym;
    } = {};

    const lookupTableDirectory: {
      [key: string]: RasaLookupTable;
    } = {};

    const existingIntentInputsDirectory: {
      [key: string]: string[];
    } = {};

    const inputTypes: {
      [key: string]: string[];
    } = {};

    if (inputData.rasa_nlu_data !== undefined) {
      let example: RasaCommonExample;
      let phraseText: string;

      // Convert the Rasa examples to intents and InputTypes
      for (example of inputData.rasa_nlu_data.common_examples) {
        if (example.intent === undefined) {
          // If the example does not have an intent defined
          // it can not be added and has to get skipped
          continue;
        }

        if (intentDirectory[example.intent] === undefined) {
          intentDirectory[example.intent] = {
            name: example.intent,
            phrases: [],
          };
        }

        // Make sure that the entities later in the text come first
        // that it does not mess up the position of the earlier ones.
        if (example.entities !== undefined && example.entities.length !== 0) {
          example.entities.sort((a, b) => (a.start < b.start ? 1 : -1));
        }

        // Replace the example entity texts with placeholders and save all
        // the used inputs
        phraseText = example.text;
        const inputNames: string[] = [];
        for (const entity of example.entities) {
          phraseText =
            phraseText.slice(0, entity.start) + `{${entity.entity}}` + phraseText.slice(entity.end);

          if (!inputNames.includes(entity.entity)) {
            inputNames.unshift(entity.entity);

            // Save all the InputTypes which exist
            if (inputTypes[entity.entity] === undefined) {
              inputTypes[entity.entity] = [entity.value];
            } else if (!inputTypes[entity.entity].includes(entity.value)) {
              inputTypes[entity.entity].push(entity.value);
            }
          }
        }

        // Add all the inputs the phrase used
        if (inputNames.length !== 0) {
          // Prepare the directory for the inputs for each intent
          // which gets added in the end to the model once everything
          // got processed.
          if (intentDirectory[example.intent].inputs === undefined) {
            intentDirectory[example.intent].inputs = [];
          }

          // Prepare the directory for the inputs for each intent
          // to not add some multiple times and to not having to look
          // through all the already added ones on the intent very time.
          if (existingIntentInputsDirectory[example.intent] === undefined) {
            existingIntentInputsDirectory[example.intent] = [];
          }

          for (const inputName of inputNames) {
            if (existingIntentInputsDirectory[example.intent].includes(inputName)) {
              continue;
            }

            existingIntentInputsDirectory[example.intent].push(inputName);

            intentDirectory[example.intent].inputs!.push({
              name: inputName,
              type: inputName,
            });
          }
        }

        intentDirectory[example.intent].phrases!.push(phraseText);
      }

      // Save the synonyms by name that they are easily accessible
      // when they are needed to create the inputTypes
      for (const synonym of inputData.rasa_nlu_data.entity_synonyms) {
        synonymDirectory[synonym.value] = synonym;
      }

      // Save the lookupTable by name that we can add all its values
      // to the inputType
      for (const lookupTable of inputData.rasa_nlu_data.lookup_tables) {
        lookupTableDirectory[lookupTable.name] = lookupTable;
      }

      let inputType: InputType;
      let values: string[];
      for (const inputTypeName of Object.keys(inputTypes)) {
        values = inputTypes[inputTypeName];

        if (lookupTableDirectory[inputTypeName] !== undefined) {
          if (Array.isArray(lookupTableDirectory[inputTypeName].elements)) {
            // Is an array of values
            for (const value of lookupTableDirectory[inputTypeName].elements) {
              if (!values.includes(value)) {
                values.push(value);
              }
            }
          } else {
            // Is a file reference
            // TODO: Add support
            throw new Error('File references in lookup_tables are not supported yet!');
          }
        }

        inputType = {
          name: inputTypeName,
          values: values.map((value) => {
            // Add all the inputType values with the synonyms
            // which got found
            const returnData: InputTypeValue = {
              value,
            };

            if (
              synonymDirectory[value] !== undefined &&
              synonymDirectory[value].synonyms !== undefined
            ) {
              returnData.synonyms = synonymDirectory[value].synonyms;
            }

            return returnData;
          }),
        };

        jovoModel.inputTypes!.push(inputType);
      }
    }

    jovoModel.intents = Object.values(intentDirectory);

    return jovoModel;
  }

  static fromJovoModel(model: JovoModelRasaData, locale: string): NativeFileInformation[] {
    const returnData: RasaNluData = {
      common_examples: [],
      entity_synonyms: [],
      lookup_tables: [],
    };

    const inputTypeNameUsedCounter: InputTypeNameUsedCounter = {};

    let rasaExample: RasaCommonExample | undefined;
    if (model.intents !== undefined) {
      for (const intent of model.intents) {
        if (intent.phrases) {
          for (const phrase of intent.phrases) {
            rasaExample = this.getRasaExampleFromPhrase(
              phrase,
              intent,
              model.inputTypes,
              inputTypeNameUsedCounter,
            );
            returnData.common_examples.push(rasaExample);
          }
        }
      }
    }

    let saveAsLookupTable: boolean;
    let rasaSynonym: RasaEntitySynonym;
    if (model.inputTypes !== undefined) {
      for (const inputType of model.inputTypes) {
        saveAsLookupTable = true;

        if (inputType.values === undefined) {
          // If an InputType does not have any values defined
          // for some reason skip it.
          continue;
        }

        // Check it it should be saved under synonyms or lookupTable

        for (const typeValue of inputType.values) {
          if (Object.keys(typeValue).length !== 1 || typeValue.value === undefined) {
            // It can only be saved as lookupTable if it does not
            // have any other properties than "value"
            saveAsLookupTable = false;
            break;
          }
        }

        if (saveAsLookupTable === true) {
          // Save a lookupTable
          returnData.lookup_tables!.push({
            name: inputType.name,
            // TODO: remove the !
            elements: inputType.values.map((data) => data.value),
          });
        } else {
          // Save as synonyms
          for (const typeValue of inputType.values) {
            rasaSynonym = {
              value: typeValue.value,
              synonyms: [],
            };

            if (typeValue.synonyms !== undefined) {
              rasaSynonym.synonyms = typeValue.synonyms;
            }

            returnData.entity_synonyms!.push(rasaSynonym);
          }
        }
      }
    }

    return [
      {
        path: [`${locale}.json`],
        content: {
          rasa_nlu_data: returnData,
        },
      },
    ];
  }

  static getRasaExampleFromPhrase(
    phrase: string,
    intent: Intent,
    inputTypes: InputType[] | undefined,
    inputTypeNameUsedCounter: InputTypeNameUsedCounter,
  ): RasaCommonExample {
    const returnData: RasaCommonExample = {
      text: phrase,
      intent: intent.name,
      entities: [],
    };

    let startIndex: number;
    let inputType: InputType | undefined;
    let intentInput: IntentInput | undefined;
    let exampleValue = '';
    let inputTypeName:
      | string
      | {
          [key: string]: string;
        };

    // Get the inputs of the phrase
    const phraseInputs = phrase.match(/{[^}]*}/g);

    // Add the ones which are defined as inputs as rasa Example
    if (phraseInputs !== null) {
      for (let inputName of phraseInputs) {
        // Cut the curly braces away
        inputName = inputName.slice(1, -1);

        if (intent.inputs === undefined) {
          // No inputs are defined so the value is not an input
          continue;
        }

        // Check if the value is really an input
        intentInput = intent.inputs.find((data) => data.name === inputName);
        if (intentInput === undefined) {
          // No input exists with that name so it is not an input
          continue;
        }

        if (intentInput.type === undefined) {
          throw new Error(
            `No type is defined for input "${inputName}" which is used in phrase "${phrase}"!`,
          );
        }

        // Get the InputType data to get an example value to replace the placeholder with
        if (inputTypes === undefined) {
          throw new Error(
            `No InputTypes are defined but type "${inputName}" is used in phrase "${phrase}"!`,
          );
        }

        inputTypeName = intentInput.type;
        if (typeof intentInput.type === 'object') {
          if (intentInput.type.rasa === undefined) {
            throw new Error(
              `No Rasa-Type is defined for input "${inputName}" which is used in phrase "${phrase}"!`,
            );
          } else {
            inputTypeName = intentInput.type.rasa as string;
          }
        } else {
          inputTypeName = inputTypeName as string;
        }

        inputType = inputTypes.find((data) => data.name === inputTypeName);
        if (inputType === undefined) {
          throw new Error(
            `InputType "${inputTypeName}" is not defined but is used in phrase "${phrase}"!`,
          );
        }
        if (inputType.values === undefined || inputType.values.length === 0) {
          throw new Error(`InputType "${inputTypeName}" does not have any values!`);
        }

        // As we are going in order of appearance in the text we can be sure
        // that the start index does not change. The end index gets calculated
        // by adding the length of the value the placeholder got replaced with.
        startIndex = returnData.text.indexOf(`{${inputName}}`);

        // Make sure that different example values get used becaues if not
        // entities do not seem to get extracted properly
        if (inputTypeNameUsedCounter[inputTypeName] === undefined) {
          inputTypeNameUsedCounter[inputTypeName] = 0;
        }
        const exampleInputIndex =
          inputTypeNameUsedCounter[inputTypeName]++ % inputType.values.length;
        exampleValue = inputType.values[exampleInputIndex].value;

        returnData.entities.push({
          value: exampleValue,
          entity: inputTypeName,
          start: startIndex,
          end: startIndex + exampleValue.length,
        });

        // Replace the placeholder with an example value
        returnData.text = returnData.text.replace(new RegExp(`{${inputName}}`, 'g'), exampleValue);
      }
    }

    return returnData;
  }

  static getValidator(): tv4.JsonSchema {
    return JovoModelRasaValidator;
  }
}
