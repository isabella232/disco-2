import * as tf from '@tensorflow/tfjs';

export default async function training(model, trainData, labels, batchSize, validationSplit, trainEpochs, updateUI){

    await model.fit(trainData, labels, {
        batchSize,
        validationSplit,
        epochs: trainEpochs,
        callbacks: {
          onEpochEnd: async (epoch, logs) => {
            const valAcc = logs.val_acc;
            document.getElementById("val_accuracy").textContent = valAcc

            updateUI(epoch+1,(logs.acc * 100).toFixed(2) ,(logs.val_acc * 100).toFixed(2))
            
            await tf.nextFrame();
          }
        }
    });

    // TODO: Enter distributed training loop
}
